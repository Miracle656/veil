import {
  Address,
  Contract,
  Keypair,
  Account,
  xdr,
  scValToNative,
  TransactionBuilder,
  rpc as SorobanRpc,
} from '@stellar/stellar-sdk'
import { getNetwork, type VeilNetworkName } from '@/lib/network'
import { getSppConfig, isPrivacyEnabled } from './config'
import { getWalletPrivacyKeys, derivePrivacyKeysFromSigner } from './keys'
import { peekFeePayerKeypair, ensureFeePayer, getFeePayerMode } from '@/lib/feePayer'

/**
 * Storage key pattern used for caching on-chain enrollment confirmation.
 */
export function getEnrollmentStorageKey(network: VeilNetworkName, address: string): string {
  return `veil_privacy_enrolled_${network}_${address}`
}

/**
 * Status returned by {@link checkPrivacyEnrollment}.
 */
export interface PrivacyEnrollmentStatus {
  /** Whether the wallet's privacy public key is registered on chain. */
  enrolled: boolean
  /** The Stellar address checked. */
  address: string
  /** Error message if verification or probe failed. */
  error?: string
}

/**
 * Result returned by {@link enrolPrivacyPublicKey}.
 */
export interface PrivacyEnrollmentResult {
  /** Whether the operation was successful. */
  success: boolean
  /** Whether the wallet was already enrolled before this call (idempotent no-op). */
  alreadyEnrolled: boolean
  /** Confirmed transaction hash if a registration transaction was executed. */
  txHash?: string
  /** Error message if enrollment failed. */
  error?: string
  /** The Stellar address enrolled. */
  address: string
}

/**
 * Checks whether a wallet's privacy public key is already registered in SPP's
 * `public_key_registry` contract.
 *
 * Checks local cache first; if absent, probes the on-chain contract via simulation.
 * When an on-chain registration is discovered on a restored wallet / new device,
 * the local cache is updated automatically without submitting a new transaction.
 */
export async function checkPrivacyEnrollment(params: {
  address: string
  networkName?: VeilNetworkName
  rpcServer?: SorobanRpc.Server
  forceProbe?: boolean
}): Promise<PrivacyEnrollmentStatus> {
  const network = getNetwork()
  const networkName = params.networkName ?? network.name
  const address = params.address

  if (!isPrivacyEnabled(networkName)) {
    return { enrolled: false, address }
  }

  const sppConfig = getSppConfig(networkName)
  if (!sppConfig || !sppConfig.publicKeyRegistry) {
    return { enrolled: false, address }
  }

  const storageKey = getEnrollmentStorageKey(networkName, address)

  if (!params.forceProbe && typeof window !== 'undefined' && window.localStorage) {
    const cached = window.localStorage.getItem(storageKey)
    if (cached === 'true') {
      return { enrolled: true, address }
    }
  }

  // Probe on-chain registry via RPC simulation
  try {
    const server = params.rpcServer ?? new SorobanRpc.Server(network.rpcUrl)
    const registry = new Contract(sppConfig.publicKeyRegistry)

    // Build read-only invocation: get(address)
    const feePayerKp = peekFeePayerKeypair() ?? Keypair.random()
    const sourceAccount = new Account(feePayerKp.publicKey(), '0')

    const tx = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: network.networkPassphrase,
    })
      .addOperation(
        registry.call('get', new Address(address).toScVal())
      )
      .setTimeout(30)
      .build()

    const sim = await server.simulateTransaction(tx)
    const simResult = (sim as any)?.result

    if (simResult?.retval) {
      const nativeVal = scValToNative(simResult.retval)
      // If the contract returns existing public key bytes or a non-null entry
      if (nativeVal !== null && nativeVal !== undefined) {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(storageKey, 'true')
        }
        return { enrolled: true, address }
      }
    }

    return { enrolled: false, address }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { enrolled: false, address, error: errorMsg }
  }
}

/**
 * Enrols the wallet's privacy public key to SPP's `public_key_registry` contract.
 *
 * Requirements:
 * - Privacy feature flag must be enabled.
 * - Idempotent: checks existing registration first.
 * - Enforces PRF-derived keypair (refuses legacy non-PRF keys).
 * - Real simulation & submission: never fakes transaction hashes.
 * - Persists confirmed state only after confirmed on-chain success.
 */
export async function enrolPrivacyPublicKey(params: {
  address: string
  signerKeypair?: Keypair
  rpcServer?: SorobanRpc.Server
  sponsorSecret?: string
  networkName?: VeilNetworkName
}): Promise<PrivacyEnrollmentResult> {
  const network = getNetwork()
  const networkName = params.networkName ?? network.name
  const address = params.address

  if (!isPrivacyEnabled(networkName)) {
    return {
      success: false,
      alreadyEnrolled: false,
      address,
      error: 'Privacy feature flag is disabled for this network',
    }
  }

  const sppConfig = getSppConfig(networkName)
  if (!sppConfig || !sppConfig.publicKeyRegistry) {
    return {
      success: false,
      alreadyEnrolled: false,
      address,
      error: 'No SPP deployment configured for this network',
    }
  }

  const storageKey = getEnrollmentStorageKey(networkName, address)

  // 1. Idempotency check: check if already registered
  const existingStatus = await checkPrivacyEnrollment({
    address,
    networkName,
    rpcServer: params.rpcServer,
  })

  if (existingStatus.enrolled) {
    return {
      success: true,
      alreadyEnrolled: true,
      address,
    }
  }

  // 2. Validate signer & derive privacy public key
  let signer = params.signerKeypair ?? peekFeePayerKeypair()
  if (!signer) {
    signer = await ensureFeePayer()
  }

  if (!signer) {
    return {
      success: false,
      alreadyEnrolled: false,
      address,
      error: 'No wallet signing key available',
    }
  }

  const mode = getFeePayerMode()
  if (mode === 'legacy') {
    return {
      success: false,
      alreadyEnrolled: false,
      address,
      error:
        'Passkey does not support PRF key derivation; private keys cannot be securely derived from legacy credentials.',
    }
  }

  let privacyKeys
  try {
    privacyKeys = derivePrivacyKeysFromSigner(signer)
  } catch (err) {
    return {
      success: false,
      alreadyEnrolled: false,
      address,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // 3. Build registration transaction
  const server = params.rpcServer ?? new SorobanRpc.Server(network.rpcUrl)
  const registry = new Contract(sppConfig.publicKeyRegistry)

  try {
    // Fetch source account for sequence number
    let accountObj: Account
    try {
      const acc = await server.getAccount(signer.publicKey())
      accountObj = new Account(acc.accountId(), acc.sequenceNumber())
    } catch {
      // Fallback account if RPC getAccount is unavailable in simulation
      accountObj = new Account(signer.publicKey(), '0')
    }

    const built = new TransactionBuilder(accountObj, {
      fee: '10000',
      networkPassphrase: network.networkPassphrase,
    })
      .addOperation(
        registry.call(
          'register',
          new Address(address).toScVal(),
          xdr.ScVal.scvBytes(privacyKeys.publicKeyBytes)
        )
      )
      .setTimeout(60)
      .build()

    // 4. Simulate transaction
    const sim = await server.simulateTransaction(built)
    if (SorobanRpc.Api.isSimulationError(sim) || ('error' in sim && (sim as any).error)) {
      return {
        success: false,
        alreadyEnrolled: false,
        address,
        error: `Simulation failed: ${(sim as any).error ?? 'unknown error'}`,
      }
    }

    // 5. Assemble transaction with footprints and sign
    let assembled: any
    try {
      assembled = SorobanRpc.assembleTransaction(built, sim).build()
    } catch {
      assembled = built
    }
    assembled.sign(signer)

    const submission = assembled

    // 6. Submit transaction
    const sendResult = await server.sendTransaction(submission)
    if (sendResult.status === 'ERROR') {
      const errDetail =
        typeof sendResult.errorResult?.toXDR === 'function'
          ? sendResult.errorResult.toXDR('base64')
          : String(sendResult.errorResult ?? 'unknown error')
      return {
        success: false,
        alreadyEnrolled: false,
        address,
        error: `Transaction rejected: ${errDetail}`,
      }
    }

    const txHash = sendResult.hash

    // 7. Poll for confirmation
    let confirmed = false
    for (let i = 0; i < 30; i++) {
      const statusRes = await server.getTransaction(txHash)
      if (statusRes.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        confirmed = true
        break
      }
      if (statusRes.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        return {
          success: false,
          alreadyEnrolled: false,
          address,
          error: `Transaction execution failed on chain for hash ${txHash}`,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    if (!confirmed) {
      return {
        success: false,
        alreadyEnrolled: false,
        address,
        error: `Transaction timed out waiting for confirmation: ${txHash}`,
      }
    }

    // 8. ONLY mark locally enrolled upon confirmed success
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(storageKey, 'true')
    }

    return {
      success: true,
      alreadyEnrolled: false,
      txHash,
      address,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      alreadyEnrolled: false,
      address,
      error: errorMsg,
    }
  }
}
