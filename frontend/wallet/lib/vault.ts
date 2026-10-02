import { inclusionFee } from './fees'
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'

import { getNetwork } from './network'
import { walletLocal, walletSession } from '@/lib/walletStorage'

const STROOPS_PER_XLM = 10_000_000n

export interface VaultConfig {
  owner: string
  token: string
  delaySeconds: number
}

export interface VaultWithdrawal {
  id: number
  to: string
  amountStroops: bigint
  amountXlm: string
  queuedAt: number
  unlockAt: number
  cancelled: boolean
  executed: boolean
}

export interface VaultDetails {
  contractId: string
  config: VaultConfig
  balanceStroops: bigint
  balanceXlm: string
  reservedStroops: bigint
  reservedXlm: string
  availableStroops: bigint
  availableXlm: string
  withdrawals: VaultWithdrawal[]
}

type SorobanMeta = {
  returnValue: () => {
    address: () => {
      contractId: () => Uint8Array
    }
  }
}

type TransactionMeta = {
  switch: () => { name: string }
  v3: () => { sorobanMeta: () => SorobanMeta }
  v4: () => { sorobanMeta: () => SorobanMeta }
}

function getVaultWasmHash(): string {
  const network = getNetwork()
  const value = network.name === 'mainnet'
    ? process.env.NEXT_PUBLIC_VAULT_WASM_HASH_MAINNET?.trim()
    : (
      process.env.NEXT_PUBLIC_VAULT_WASM_HASH_TESTNET?.trim()
      || process.env.NEXT_PUBLIC_VAULT_WASM_HASH?.trim()
    )

  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      `Vault deployment is not configured for ${network.displayName}. Set the matching NEXT_PUBLIC_VAULT_WASM_HASH environment variable.`
    )
  }

  return value
}

function getSigner(secret?: string): Keypair {
  const stored = typeof window === 'undefined'
    ? null
    : (
      walletSession.getItem('veil_signer_secret')
      || walletLocal.getItem('veil_signer_secret')
    )
  const resolved = secret?.trim() || stored

  if (!resolved) {
    throw new Error('Signing key not found. Unlock the wallet again.')
  }

  return Keypair.fromSecret(resolved)
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' || typeof value === 'string') return BigInt(value)
  throw new Error('Unexpected integer value returned by the vault contract.')
}

function asNumber(value: unknown): number {
  const number = Number(asBigInt(value))
  if (!Number.isSafeInteger(number)) {
    throw new Error('Vault value exceeds the browser safe integer range.')
  }
  return number
}

function validateStellarAddress(value: string): string {
  const address = value.trim()
  try {
    Address.fromString(address)
  } catch {
    throw new Error('Enter a valid Stellar G... or C... address.')
  }
  return address
}

export function xlmToStroops(value: string): bigint {
  const amount = value.trim()
  if (!/^\d+(?:\.\d{0,7})?$/.test(amount)) {
    throw new Error('Enter a valid XLM amount with no more than 7 decimal places.')
  }

  const [whole, fraction = ''] = amount.split('.')
  const stroops = BigInt(whole) * STROOPS_PER_XLM
    + BigInt(fraction.padEnd(7, '0'))

  if (stroops <= 0n) {
    throw new Error('Amount must be greater than zero.')
  }
  return stroops
}

export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n
  const absolute = negative ? -stroops : stroops
  const whole = absolute / STROOPS_PER_XLM
  const fraction = (absolute % STROOPS_PER_XLM)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

async function waitForTransaction(
  server: SorobanRpc.Server,
  hash: string,
): Promise<SorobanRpc.Api.GetTransactionResponse> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await server.getTransaction(hash)
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Vault transaction failed with status ${result.status}.`)
      }
      return result
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error('Vault transaction timed out. Check its status on Stellar Explorer.')
}

async function submitOperation(
  operation: xdr.Operation,
  signer: Keypair,
): Promise<string> {
  const network = getNetwork()
  const server = new SorobanRpc.Server(network.rpcUrl)
  const account = await server.getAccount(signer.publicKey())
  const transaction = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build()

  const simulation = await server.simulateTransaction(transaction)
  if (SorobanRpc.Api.isSimulationError(simulation)) {
    throw new Error(`Vault simulation failed: ${simulation.error}`)
  }

  const assembled = SorobanRpc.assembleTransaction(transaction, simulation).build()
  assembled.sign(signer)

  const submitted = await server.sendTransaction(assembled)
  if (submitted.status === 'ERROR') {
    throw new Error(
      `Vault transaction was rejected: ${submitted.errorResult?.toXDR('base64') ?? 'unknown error'}`
    )
  }

  await waitForTransaction(server, submitted.hash)
  return submitted.hash
}

async function simulateCall(
  contract: Contract,
  method: string,
  ...args: xdr.ScVal[]
): Promise<unknown> {
  const network = getNetwork()
  const server = new SorobanRpc.Server(network.rpcUrl)
  const account = new Account(Keypair.random().publicKey(), '0')
  const transaction = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const simulation = await server.simulateTransaction(transaction)
  if (SorobanRpc.Api.isSimulationError(simulation)) {
    throw new Error(`Could not read ${method} from the vault: ${simulation.error}`)
  }
  if (!simulation.result) {
    throw new Error(`Vault read ${method} returned no result.`)
  }

  return scValToNative(simulation.result.retval)
}

function extractContractId(
  response: SorobanRpc.Api.GetTransactionResponse,
): string {
  if (response.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error('Vault deployment did not succeed.')
  }

  const meta = response.resultMetaXdr as unknown as TransactionMeta
  const metaVersion = meta.switch().name
  const sorobanMeta = metaVersion === 'transactionMetaV4'
    ? meta.v4().sorobanMeta()
    : meta.v3().sorobanMeta()
  const rawContractId = sorobanMeta.returnValue().address().contractId()
  return StrKey.encodeContract(Buffer.from(rawContractId))
}

export async function deployAndInitializeVault(params: {
  delaySeconds: number
  signerSecret?: string
}): Promise<string> {
  if (!Number.isSafeInteger(params.delaySeconds) || params.delaySeconds <= 0) {
    throw new Error('Withdrawal delay must be a positive whole number of seconds.')
  }

  const network = getNetwork()
  const signer = getSigner(params.signerSecret)
  const server = new SorobanRpc.Server(network.rpcUrl)
  const account = await server.getAccount(signer.publicKey())
  const salt = crypto.getRandomValues(new Uint8Array(32))

  const deployTransaction = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(Operation.createCustomContract({
      address: signer.publicKey() as unknown as Address,
      wasmHash: Buffer.from(getVaultWasmHash(), 'hex'),
      salt: Buffer.from(salt),
    }))
    .setTimeout(60)
    .build()

  const prepared = await server.prepareTransaction(deployTransaction)
  prepared.sign(signer)
  const submitted = await server.sendTransaction(prepared)
  if (submitted.status === 'ERROR') {
    throw new Error(
      `Vault deployment was rejected: ${submitted.errorResult?.toXDR('base64') ?? 'unknown error'}`
    )
  }

  const deployment = await waitForTransaction(server, submitted.hash)
  const contractId = extractContractId(deployment)
  const contract = new Contract(contractId)
  const tokenAddress = Asset.native().contractId(network.networkPassphrase)

  await submitOperation(
    contract.call(
      'initialize',
      nativeToScVal(signer.publicKey(), { type: 'address' }),
      nativeToScVal(tokenAddress, { type: 'address' }),
      nativeToScVal(BigInt(params.delaySeconds), { type: 'u64' }),
    ),
    signer,
  )

  return contractId
}

export async function depositToVault(params: {
  contractId: string
  amountXlm: string
  signerSecret?: string
}): Promise<string> {
  const network = getNetwork()
  const signer = getSigner(params.signerSecret)
  const contractId = validateStellarAddress(params.contractId)
  const token = new Contract(Asset.native().contractId(network.networkPassphrase))

  return submitOperation(
    token.call(
      'transfer',
      nativeToScVal(signer.publicKey(), { type: 'address' }),
      nativeToScVal(contractId, { type: 'address' }),
      nativeToScVal(xlmToStroops(params.amountXlm), { type: 'i128' }),
    ),
    signer,
  )
}

export async function queueVaultWithdrawal(params: {
  contractId: string
  to: string
  amountXlm: string
  signerSecret?: string
}): Promise<string> {
  const signer = getSigner(params.signerSecret)
  const contract = new Contract(validateStellarAddress(params.contractId))

  return submitOperation(
    contract.call(
      'queue_withdrawal',
      nativeToScVal(validateStellarAddress(params.to), { type: 'address' }),
      nativeToScVal(xlmToStroops(params.amountXlm), { type: 'i128' }),
    ),
    signer,
  )
}

export async function cancelVaultWithdrawal(params: {
  contractId: string
  withdrawalId: number
  signerSecret?: string
}): Promise<string> {
  const signer = getSigner(params.signerSecret)
  const contract = new Contract(validateStellarAddress(params.contractId))

  return submitOperation(
    contract.call(
      'cancel_withdrawal',
      nativeToScVal(BigInt(params.withdrawalId), { type: 'u64' }),
    ),
    signer,
  )
}

export async function executeVaultWithdrawal(params: {
  contractId: string
  withdrawalId: number
  signerSecret?: string
}): Promise<string> {
  const signer = getSigner(params.signerSecret)
  const contract = new Contract(validateStellarAddress(params.contractId))

  return submitOperation(
    contract.call(
      'execute_withdrawal',
      nativeToScVal(BigInt(params.withdrawalId), { type: 'u64' }),
    ),
    signer,
  )
}

export async function fetchVaultDetails(contractIdValue: string): Promise<VaultDetails> {
  const contractId = validateStellarAddress(contractIdValue)
  const contract = new Contract(contractId)

  const rawConfig = await simulateCall(contract, 'get_config') as Record<string, unknown>
  const config: VaultConfig = {
    owner: String(rawConfig.owner),
    token: String(rawConfig.token),
    delaySeconds: asNumber(rawConfig.delay_seconds),
  }

  const token = new Contract(config.token)
  const [rawBalance, rawReserved, rawAvailable, rawCount] = await Promise.all([
    simulateCall(
      token,
      'balance',
      nativeToScVal(contractId, { type: 'address' }),
    ),
    simulateCall(contract, 'get_reserved_amount'),
    simulateCall(contract, 'get_available_balance'),
    simulateCall(contract, 'get_withdrawal_count'),
  ])

  const withdrawalCount = asNumber(rawCount)
  const withdrawals = await Promise.all(
    Array.from({ length: withdrawalCount }, async (_, index) => {
      const raw = await simulateCall(
        contract,
        'get_withdrawal',
        nativeToScVal(BigInt(index + 1), { type: 'u64' }),
      ) as Record<string, unknown>
      const amountStroops = asBigInt(raw.amount)

      return {
        id: asNumber(raw.id),
        to: String(raw.to),
        amountStroops,
        amountXlm: stroopsToXlm(amountStroops),
        queuedAt: asNumber(raw.queued_at),
        unlockAt: asNumber(raw.unlock_at),
        cancelled: Boolean(raw.cancelled),
        executed: Boolean(raw.executed),
      }
    })
  )

  const balanceStroops = asBigInt(rawBalance)
  const reservedStroops = asBigInt(rawReserved)
  const availableStroops = asBigInt(rawAvailable)

  return {
    contractId,
    config,
    balanceStroops,
    balanceXlm: stroopsToXlm(balanceStroops),
    reservedStroops,
    reservedXlm: stroopsToXlm(reservedStroops),
    availableStroops,
    availableXlm: stroopsToXlm(availableStroops),
    withdrawals: withdrawals.sort((left, right) => right.id - left.id),
  }
}
