/**
 * @jest-environment jsdom
 *
 * Tests for lib/vault.ts: the web wallet's client for the timelocked vault
 * contract (contracts/vault).
 *
 * A vault's value is entirely in what it prevents, so the restrictions come
 * first. They are enforced in two places, and these tests are honest about
 * which is which:
 *
 *  - The client (vault.ts) refuses bad input before anything is signed: a
 *    zero, negative or over-precise amount; a malformed address; a deposit to
 *    something that is not this wallet's XLM vault; a non-positive delay; a
 *    missing signing key. Those refusals are proven here directly, by asserting
 *    nothing was simulated, signed or sent.
 *  - The contract enforces the timelock, the available-balance limit, owner
 *    auth and no-replay. The client cannot enforce those; what it must do is
 *    send exact values and stop — without signing — when simulation refuses.
 *    The fake chain below applies the contract's rules as written in
 *    contracts/vault/src/lib.rs, so those refusals reach the client as they
 *    would on the network. That proves the client's half. The rules themselves
 *    are proven by the Rust tests in that file; a fake is not a substitute.
 *
 * What is real: the module, @stellar/stellar-sdk (transaction building, XDR,
 * ScVal encoding, assembleTransaction, signing). What is faked: the Soroban RPC
 * (`rpc.Server.prototype`), recorded so "nothing was signed or sent" can be
 * asserted. `Transaction.prototype.sign` is spied on for the same reason.
 *
 * Every address is derived from a fixed seed with StrKey / Keypair, never typed
 * by hand, so none can be truncated or invented. No secret is printed.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import * as sdk from '@stellar/stellar-sdk'
import { createHash } from 'crypto'
import {
  xlmToStroops,
  stroopsToXlm,
  deployAndInitializeVault,
  depositToVault,
  queueVaultWithdrawal,
  cancelVaultWithdrawal,
  executeVaultWithdrawal,
  fetchVaultDetails,
} from '../vault'
import { getNetwork } from '../network'

const { Keypair, StrKey, Asset, Address, xdr, nativeToScVal, scValToNative } = sdk

// ── Fixtures ────────────────────────────────────────────────────────────────

const seed = (label: string) => createHash('sha256').update(`veil #1206 ${label}`).digest()
const OWNER = Keypair.fromRawEd25519Seed(seed('owner'))
const STRANGER = Keypair.fromRawEd25519Seed(seed('stranger'))
const RECIPIENT = Keypair.fromRawEd25519Seed(seed('recipient')).publicKey()
const VAULT = StrKey.encodeContract(seed('vault'))
const NOT_A_VAULT = StrKey.encodeContract(seed('some other contract'))
const OTHER_TOKEN = StrKey.encodeContract(seed('another token'))
const NATIVE = Asset.native().contractId(getNetwork().networkPassphrase)
const WASM_HASH = createHash('sha256').update('veil #1206 vault wasm').digest('hex')

const DELAY = 86_400
const XLM = 10_000_000n

// ── A fake chain applying contracts/vault/src/lib.rs ────────────────────────

interface Withdrawal {
  id: bigint
  to: string
  amount: bigint
  queued_at: bigint
  unlock_at: bigint
  cancelled: boolean
  executed: boolean
}

interface VaultState {
  config: { owner: string; token: string; delay_seconds: bigint } | null
  balance: bigint
  reserved: bigint
  withdrawals: Withdrawal[]
}

/** VaultError discriminants, as declared in the contract. */
const E = {
  NotInitialized: 2,
  InvalidAmount: 4,
  WithdrawalNotFound: 5,
  WithdrawalNotPending: 6,
  TimelockActive: 7,
  InsufficientAvailableBalance: 8,
} as const

class ContractError extends Error {
  constructor(code: number) {
    super(`HostError: Error(Contract, #${code})`)
  }
}

let now: bigint
let vaults: Map<string, VaultState>

function vault(id: string): VaultState {
  const v = vaults.get(id)
  if (!v) throw new Error('HostError: Error(Storage, MissingValue)')
  return v
}

function config(id: string) {
  const c = vault(id).config
  if (!c) throw new ContractError(E.NotInitialized)
  return c
}

function load(id: string, wid: bigint) {
  const w = vault(id).withdrawals.find((x) => x.id === wid)
  if (!w) throw new ContractError(E.WithdrawalNotFound)
  return w
}

/** Struct → ScVal map with symbol keys in sorted order, as Soroban encodes it. */
function struct(fields: Record<string, sdk.xdr.ScVal>): sdk.xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k] })),
  )
}

function withdrawalScVal(w: Withdrawal) {
  return struct({
    id: nativeToScVal(w.id, { type: 'u64' }),
    to: nativeToScVal(w.to, { type: 'address' }),
    amount: nativeToScVal(w.amount, { type: 'i128' }),
    queued_at: nativeToScVal(w.queued_at, { type: 'u64' }),
    unlock_at: nativeToScVal(w.unlock_at, { type: 'u64' }),
    cancelled: xdr.ScVal.scvBool(w.cancelled),
    executed: xdr.ScVal.scvBool(w.executed),
  })
}

/** Run one invokeContract call against the fake chain, as simulation would. */
function invoke(contractId: string, fn: string, args: unknown[], source: string): sdk.xdr.ScVal {
  if (contractId === NATIVE || contractId === OTHER_TOKEN) {
    if (fn === 'balance') return nativeToScVal(vaults.get(String(args[0]))?.balance ?? 0n, { type: 'i128' })
    if (fn === 'transfer') return xdr.ScVal.scvVoid()
    throw new Error(`fake token: no ${fn}`)
  }
  const v = vault(contractId)
  switch (fn) {
    case 'get_config': {
      const c = config(contractId)
      return struct({
        owner: nativeToScVal(c.owner, { type: 'address' }),
        token: nativeToScVal(c.token, { type: 'address' }),
        delay_seconds: nativeToScVal(c.delay_seconds, { type: 'u64' }),
      })
    }
    case 'initialize':
      return xdr.ScVal.scvVoid()
    case 'get_reserved_amount':
      return nativeToScVal(v.reserved, { type: 'i128' })
    case 'get_available_balance':
      config(contractId)
      return nativeToScVal(v.balance - v.reserved, { type: 'i128' })
    case 'get_withdrawal_count':
      return nativeToScVal(BigInt(v.withdrawals.length), { type: 'u64' })
    case 'get_withdrawal':
      return withdrawalScVal(load(contractId, args[0] as bigint))
    case 'queue_withdrawal': {
      const [to, amount] = args as [string, bigint]
      if (amount <= 0n) throw new ContractError(E.InvalidAmount)
      const c = config(contractId)
      if (source !== c.owner) throw new Error('HostError: Error(Auth, InvalidAction)')
      if (amount > v.balance - v.reserved) throw new ContractError(E.InsufficientAvailableBalance)
      return nativeToScVal(BigInt(v.withdrawals.length + 1), { type: 'u64' })
    }
    case 'cancel_withdrawal': {
      const c = config(contractId)
      if (source !== c.owner) throw new Error('HostError: Error(Auth, InvalidAction)')
      const w = load(contractId, args[0] as bigint)
      if (w.cancelled || w.executed) throw new ContractError(E.WithdrawalNotPending)
      return xdr.ScVal.scvVoid()
    }
    case 'execute_withdrawal': {
      config(contractId)
      const w = load(contractId, args[0] as bigint)
      if (w.cancelled || w.executed) throw new ContractError(E.WithdrawalNotPending)
      if (now < w.unlock_at) throw new ContractError(E.TimelockActive)
      return xdr.ScVal.scvVoid()
    }
    default:
      throw new Error(`fake vault: no ${fn}`)
  }
}

/** Apply a submitted (successful) call's effects, as the ledger would. */
function apply(contractId: string, fn: string, args: unknown[]) {
  if (contractId === NATIVE && fn === 'transfer') {
    const [, to, amount] = args as [string, string, bigint]
    const target = vaults.get(to)
    if (target) target.balance += amount
    return
  }
  const v = vaults.get(contractId)
  if (!v) return
  if (fn === 'initialize') {
    const [owner, token, delay] = args as [string, string, bigint]
    v.config = { owner, token, delay_seconds: delay }
  } else if (fn === 'queue_withdrawal') {
    const [to, amount] = args as [string, bigint]
    const c = v.config!
    v.withdrawals.push({
      id: BigInt(v.withdrawals.length + 1),
      to,
      amount,
      queued_at: now,
      unlock_at: now + c.delay_seconds,
      cancelled: false,
      executed: false,
    })
    v.reserved += amount
  } else if (fn === 'cancel_withdrawal') {
    const w = load(contractId, args[0] as bigint)
    w.cancelled = true
    v.reserved -= w.amount
  } else if (fn === 'execute_withdrawal') {
    const w = load(contractId, args[0] as bigint)
    w.executed = true
    v.reserved -= w.amount
    v.balance -= w.amount
  }
}

/** Decode the single invokeContract operation of a transaction. */
function decodeCall(tx: sdk.Transaction) {
  const op = tx.operations[0] as sdk.Operation.InvokeHostFunction
  const ic = op.func.invokeContract()
  return {
    contractId: Address.fromScAddress(ic.contractAddress()).toString(),
    fn: ic.functionName().toString(),
    args: ic.args().map((a) => scValToNative(a)),
    rawArgs: ic.args(),
  }
}

function simSuccess(retval: sdk.xdr.ScVal) {
  return {
    _parsed: true,
    id: '1',
    latestLedger: 1000,
    events: [],
    transactionData: new sdk.SorobanDataBuilder(),
    minResourceFee: '1000',
    result: { auth: [], retval },
  }
}

// ── RPC spies ───────────────────────────────────────────────────────────────

let rpc: {
  getAccount: jest.SpyInstance
  simulateTransaction: jest.SpyInstance
  prepareTransaction: jest.SpyInstance
  sendTransaction: jest.SpyInstance
  getTransaction: jest.SpyInstance
}
let txSign: jest.SpyInstance
/** Transactions handed to sendTransaction, decoded, in order. */
let sent: Array<ReturnType<typeof decodeCall> | { deploy: sdk.Transaction }>
let pendingByHash: Map<string, () => void>
/** What getTransaction answers for a hash, after the effects are applied. */
let txOutcome: (hash: string) => any
let deployedId: string

const SUCCESS = sdk.rpc.Api.GetTransactionStatus.SUCCESS

beforeEach(() => {
  now = 1_000n
  vaults = new Map([
    [VAULT, { config: { owner: OWNER.publicKey(), token: NATIVE, delay_seconds: BigInt(DELAY) }, balance: 0n, reserved: 0n, withdrawals: [] }],
    [NOT_A_VAULT, { config: null, balance: 0n, reserved: 0n, withdrawals: [] }],
  ])
  sent = []
  pendingByHash = new Map()
  deployedId = StrKey.encodeContract(seed('freshly deployed vault'))
  txOutcome = () => ({ status: SUCCESS })

  process.env.NEXT_PUBLIC_VAULT_WASM_HASH_TESTNET = WASM_HASH
  localStorage.clear()
  sessionStorage.clear()

  const proto = sdk.rpc.Server.prototype as any
  rpc = {
    getAccount: jest.spyOn(proto, 'getAccount').mockImplementation(async (pub: any) => new sdk.Account(String(pub), '5')),
    simulateTransaction: jest.spyOn(proto, 'simulateTransaction').mockImplementation(async (tx: any) => {
      const call = decodeCall(tx)
      try {
        return simSuccess(invoke(call.contractId, call.fn, call.args, tx.source))
      } catch (e) {
        return { id: '1', latestLedger: 1000, events: [], error: (e as Error).message }
      }
    }),
    prepareTransaction: jest.spyOn(proto, 'prepareTransaction').mockImplementation(async (tx: any) => tx),
    sendTransaction: jest.spyOn(proto, 'sendTransaction').mockImplementation(async (tx: any) => {
      const hash = tx.hash().toString('hex')
      const op = tx.operations[0]
      if (op.func.switch().name === 'hostFunctionTypeCreateContractV2' || op.func.switch().name === 'hostFunctionTypeCreateContract') {
        sent.push({ deploy: tx })
        vaults.set(deployedId, { config: null, balance: 0n, reserved: 0n, withdrawals: [] })
      } else {
        const call = decodeCall(tx)
        sent.push(call)
        pendingByHash.set(hash, () => apply(call.contractId, call.fn, call.args))
      }
      return { status: 'PENDING', hash }
    }),
    getTransaction: jest.spyOn(proto, 'getTransaction').mockImplementation(async (hash: any) => {
      pendingByHash.get(String(hash))?.()
      pendingByHash.delete(String(hash))
      const outcome = txOutcome(String(hash))
      if (outcome.status === SUCCESS && !outcome.resultMetaXdr) outcome.resultMetaXdr = metaReturning(deployedId)
      return outcome
    }),
  }
  txSign = jest.spyOn(sdk.Transaction.prototype, 'sign')
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
  delete process.env.NEXT_PUBLIC_VAULT_WASM_HASH_TESTNET
  delete process.env.NEXT_PUBLIC_VAULT_WASM_HASH
})

/** The duck-typed result meta extractContractId reads (v4 by default). */
function metaReturning(contractId: string, version: 'transactionMetaV3' | 'transactionMetaV4' = 'transactionMetaV4') {
  const sorobanMeta = () => ({
    returnValue: () => ({ address: () => ({ contractId: () => StrKey.decodeContract(contractId) }) }),
  })
  return { switch: () => ({ name: version }), v3: () => ({ sorobanMeta }), v4: () => ({ sorobanMeta }) }
}

/**
 * Nothing reached the network's write path, and no key signed anything.
 * Counts, not toHaveBeenCalled: on failure jest prints a spy's call arguments,
 * and sign()'s argument is the Keypair, secret included.
 */
function expectNothingSignedOrSent() {
  expect(txSign.mock.calls.length).toBe(0)
  expect(rpc.sendTransaction.mock.calls.length).toBe(0)
}

const as = (kp: sdk.Keypair) => ({ signerSecret: kp.secret() })

async function fund(stroops: bigint) {
  vaults.get(VAULT)!.balance += stroops
}

// ── Amounts ─────────────────────────────────────────────────────────────────

describe('xlmToStroops', () => {
  it('converts exactly, with no floating point anywhere', () => {
    // Breaks: 0.1 + 0.2 style rounding — the vault would reserve or release a
    // stroop more or less than the user typed.
    expect(xlmToStroops('1')).toBe(XLM)
    expect(xlmToStroops('0.1')).toBe(1_000_000n)
    expect(xlmToStroops('0.3')).toBe(3_000_000n)
    expect(xlmToStroops('1.2345678')).toBe(12_345_678n)
    expect(xlmToStroops('922337203685.4775807')).toBe(9_223_372_036_854_775_807n) // i64 max in stroops
    expect(xlmToStroops('100000000000000000000.0000001')).toBe(100_000_000_000_000_000_000n * XLM + 1n)
  })

  it('accepts the smallest positive amount, one stroop', () => {
    // Boundary: just above zero. Breaks: the minimum deposit refused.
    expect(xlmToStroops('0.0000001')).toBe(1n)
  })

  it('refuses zero in every spelling', () => {
    // Boundary: zero. Breaks: a zero-amount transaction signed and paid for.
    for (const zero of ['0', '0.0', '0.0000000', '000', '0.']) {
      expect(() => xlmToStroops(zero)).toThrow('greater than zero')
    }
  })

  it('refuses an eighth decimal place instead of rounding it away', () => {
    // Boundary: one past the precision limit. Breaks: '0.00000001' silently
    // becoming 0 or 1 stroop.
    expect(() => xlmToStroops('0.00000001')).toThrow('7 decimal places')
    expect(() => xlmToStroops('1.12345678')).toThrow('7 decimal places')
  })

  it('refuses negative, signed, exponent and garbled amounts', () => {
    // Breaks: '-5' parsed as 5, or '1e3' as 1000.
    for (const bad of ['-1', '+1', '1e3', '.5', '1,000', '1.2.3', 'abc', '', ' ', 'Infinity', 'NaN', '0x10', '１']) {
      expect(() => xlmToStroops(bad)).toThrow()
    }
  })

  it('tolerates surrounding whitespace, nothing else', () => {
    // Breaks: a pasted amount with a trailing newline refused.
    expect(xlmToStroops('  2.5\n')).toBe(25_000_000n)
    expect(() => xlmToStroops('2 .5')).toThrow()
  })
})

describe('stroopsToXlm', () => {
  it('formats exactly and trims trailing zeros', () => {
    // Breaks: the balance shown differing from the balance held.
    expect(stroopsToXlm(0n)).toBe('0')
    expect(stroopsToXlm(1n)).toBe('0.0000001')
    expect(stroopsToXlm(XLM)).toBe('1')
    expect(stroopsToXlm(12_345_678n)).toBe('1.2345678')
    expect(stroopsToXlm(15_000_000n)).toBe('1.5')
    expect(stroopsToXlm(-1n)).toBe('-0.0000001')
    expect(stroopsToXlm(-25_000_000n)).toBe('-2.5')
  })

  it('round-trips with xlmToStroops for every positive amount it produces', () => {
    // Breaks: "withdraw all" (typing back the shown available amount) asking
    // for a different amount than is available.
    for (const v of [1n, 9n, 10n, 999_999n, XLM - 1n, XLM, XLM + 1n, 123_456_789_012n, 2n ** 63n - 1n]) {
      expect(xlmToStroops(stroopsToXlm(v))).toBe(v)
    }
  })
})

// ── Signing key ─────────────────────────────────────────────────────────────

describe('the signing key', () => {
  it('without one, every write is refused before touching the network', async () => {
    // Breaks: a locked wallet still able to move vault funds.
    await expect(depositToVault({ contractId: VAULT, amountXlm: '1' })).rejects.toThrow('Signing key not found')
    await expect(queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '1' })).rejects.toThrow('Signing key not found')
    await expect(cancelVaultWithdrawal({ contractId: VAULT, withdrawalId: 1 })).rejects.toThrow('Signing key not found')
    await expect(executeVaultWithdrawal({ contractId: VAULT, withdrawalId: 1 })).rejects.toThrow('Signing key not found')
    await expect(deployAndInitializeVault({ delaySeconds: DELAY })).rejects.toThrow('Signing key not found')
    expect(rpc.getAccount).not.toHaveBeenCalled()
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expectNothingSignedOrSent()
  })

  it('uses the session key before a persisted one, and an explicit one over both', async () => {
    // Breaks: a stale key from another wallet signing for this vault.
    await fund(10n * XLM)
    localStorage.setItem('veil_signer_secret', STRANGER.secret())
    sessionStorage.setItem('veil_signer_secret', OWNER.secret())
    await queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '1' })
    expect(rpc.getAccount).toHaveBeenLastCalledWith(OWNER.publicKey())

    sessionStorage.clear()
    localStorage.setItem('veil_signer_secret', OWNER.secret())
    await queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '1' })
    expect(rpc.getAccount).toHaveBeenLastCalledWith(OWNER.publicKey())

    await expect(queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '1', ...as(STRANGER) })).rejects.toThrow('Auth')
    expect(rpc.getAccount).toHaveBeenLastCalledWith(STRANGER.publicKey())
  })

  it('refuses a malformed secret without echoing it', async () => {
    // Breaks: a key shown in an error toast or a log.
    const bad = 'S' + 'A'.repeat(55)
    const err = await queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '1', signerSecret: bad }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).not.toContain(bad)
    expectNothingSignedOrSent()
  })
})

// ── Deploy ──────────────────────────────────────────────────────────────────

describe('deployAndInitializeVault', () => {
  it('refuses a delay that is not a positive whole number of seconds', async () => {
    // Boundary: zero, and the non-integers around it. A zero delay is a vault
    // with no lock. Breaks: a "vault" that restricts nothing.
    for (const d of [0, -1, 0.5, 1.5, NaN, Infinity, 2 ** 53]) {
      await expect(deployAndInitializeVault({ delaySeconds: d, ...as(OWNER) })).rejects.toThrow('positive whole number')
    }
    expect(rpc.getAccount).not.toHaveBeenCalled()
    expectNothingSignedOrSent()
  })

  it('accepts the smallest delay, one second', async () => {
    // Boundary: just above zero.
    await expect(deployAndInitializeVault({ delaySeconds: 1, ...as(OWNER) })).resolves.toBe(deployedId)
  })

  it('refuses to deploy without a configured wasm hash, or with a malformed one', async () => {
    // Breaks: deploying whatever code a typo'd hash points at.
    delete process.env.NEXT_PUBLIC_VAULT_WASM_HASH_TESTNET
    await expect(deployAndInitializeVault({ delaySeconds: DELAY, ...as(OWNER) })).rejects.toThrow('not configured')
    process.env.NEXT_PUBLIC_VAULT_WASM_HASH_TESTNET = WASM_HASH.slice(0, 63)
    await expect(deployAndInitializeVault({ delaySeconds: DELAY, ...as(OWNER) })).rejects.toThrow('not configured')
    process.env.NEXT_PUBLIC_VAULT_WASM_HASH_TESTNET = 'z'.repeat(64)
    await expect(deployAndInitializeVault({ delaySeconds: DELAY, ...as(OWNER) })).rejects.toThrow('not configured')
    expectNothingSignedOrSent()
  })

  it('deploys the configured code, then initialises it owned by the signer, holding XLM, with the delay', async () => {
    // Breaks: a vault owned by someone else, for another token, or with a
    // different lock than the user chose.
    const id = await deployAndInitializeVault({ delaySeconds: DELAY, ...as(OWNER) })
    expect(id).toBe(deployedId)
    expect(StrKey.isValidContract(id)).toBe(true)

    expect(sent).toHaveLength(2)
    const deploy = (sent[0] as { deploy: sdk.Transaction }).deploy
    const create = (deploy.operations[0] as sdk.Operation.InvokeHostFunction).func
    const args = create.switch().name === 'hostFunctionTypeCreateContractV2' ? create.createContractV2() : create.createContract()
    expect(args.executable().wasmHash().toString('hex')).toBe(WASM_HASH)
    // FINDING, fixed here: this was passed as a bare string, and the SDK threw
    // before anything was built. Breaks: no vault can be created at all.
    const deployer = args.contractIdPreimage().fromAddress().address()
    expect(Address.fromScAddress(deployer).toString()).toBe(OWNER.publicKey())
    expect(args.contractIdPreimage().fromAddress().salt()).toHaveLength(32)

    const init = sent[1] as ReturnType<typeof decodeCall>
    expect(init.contractId).toBe(deployedId)
    expect(init.fn).toBe('initialize')
    expect(init.args).toEqual([OWNER.publicKey(), NATIVE, BigInt(DELAY)])
    expect(init.rawArgs[2].switch().name).toBe('scvU64')
  })

  it('reads the new contract id from v3 result meta too', async () => {
    // Breaks: deploy "failing" on an RPC that still returns v3 meta, leaving
    // an uninitialised vault anyone could claim.
    txOutcome = () => ({ status: SUCCESS, resultMetaXdr: metaReturning(deployedId, 'transactionMetaV3') })
    await expect(deployAndInitializeVault({ delaySeconds: DELAY, ...as(OWNER) })).resolves.toBe(deployedId)
  })

  it('stops if the deployment is rejected or fails, without sending initialize', async () => {
    // Breaks: initialize sent to a contract that does not exist.
    rpc.sendTransaction.mockResolvedValueOnce({ status: 'ERROR', hash: 'x' })
    await expect(deployAndInitializeVault({ delaySeconds: DELAY, ...as(OWNER) })).rejects.toThrow('deployment was rejected')
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1)

    rpc.sendTransaction.mockClear()
    txOutcome = () => ({ status: sdk.rpc.Api.GetTransactionStatus.FAILED })
    await expect(deployAndInitializeVault({ delaySeconds: DELAY, ...as(OWNER) })).rejects.toThrow('failed with status FAILED')
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1)
  })
})

// ── Deposit ─────────────────────────────────────────────────────────────────

describe('depositToVault refuses before sending', () => {
  it('a zero, negative or over-precise amount, before any network call', async () => {
    // Boundaries: zero and one past the precision limit.
    for (const amountXlm of ['0', '-1', '0.00000001']) {
      await expect(depositToVault({ contractId: VAULT, amountXlm, ...as(OWNER) })).rejects.toThrow()
    }
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expectNothingSignedOrSent()
  })

  it('a malformed address', async () => {
    // Breaks: a typo'd vault id sent to the token contract as-is.
    for (const contractId of ['', 'C', VAULT.slice(0, 55), VAULT + 'A', VAULT.toLowerCase()]) {
      await expect(depositToVault({ contractId, amountXlm: '1', ...as(OWNER) })).rejects.toThrow('valid Stellar')
    }
    expectNothingSignedOrSent()
  })

  it('a G... account — a plain payment with no timelock at all', async () => {
    // FINDING, fixed here: this used to be accepted and sent as an ordinary
    // XLM payment. Breaks: money the user believes is locked, isn't.
    await expect(depositToVault({ contractId: RECIPIENT, amountXlm: '1', ...as(OWNER) })).rejects.toThrow('starts with C')
    expectNothingSignedOrSent()
  })

  it('a contract that is not an initialised vault', async () => {
    // FINDING, fixed here. An uninitialised vault's `initialize` is open to
    // anyone, who then owns whatever was deposited. Breaks: the deposit lost.
    await expect(depositToVault({ contractId: NOT_A_VAULT, amountXlm: '1', ...as(OWNER) })).rejects.toThrow('not an initialised vault')
    const unknown = StrKey.encodeContract(seed('nothing deployed here'))
    await expect(depositToVault({ contractId: unknown, amountXlm: '1', ...as(OWNER) })).rejects.toThrow('not an initialised vault')
    expectNothingSignedOrSent()
  })

  it('a vault for a different token', async () => {
    // FINDING, fixed here. The vault only ever transfers its configured token,
    // so XLM sent to it can never come back. Breaks: XLM stranded for good.
    vaults.get(VAULT)!.config!.token = OTHER_TOKEN
    await expect(depositToVault({ contractId: VAULT, amountXlm: '1', ...as(OWNER) })).rejects.toThrow('does not hold XLM')
    expectNothingSignedOrSent()
  })

  it('a vault owned by a different key', async () => {
    // FINDING, fixed here. Only the owner can queue a withdrawal. Breaks: a
    // deposit this wallet can never withdraw.
    await expect(depositToVault({ contractId: VAULT, amountXlm: '1', ...as(STRANGER) })).rejects.toThrow('belongs to a different key')
    expectNothingSignedOrSent()
  })
})

describe('depositToVault sends', () => {
  it('an XLM transfer from the signer to the vault, for the exact amount', async () => {
    // Breaks: a deposit from the wrong account, to the wrong place, or for a
    // rounded amount.
    await depositToVault({ contractId: VAULT, amountXlm: '12.3456789', ...as(OWNER) })
    expect(sent).toHaveLength(1)
    const call = sent[0] as ReturnType<typeof decodeCall>
    expect(call.contractId).toBe(NATIVE)
    expect(call.fn).toBe('transfer')
    expect(call.args).toEqual([OWNER.publicKey(), VAULT, 123_456_789n])
    expect(call.rawArgs[2].switch().name).toBe('scvI128')
    expect(txSign.mock.calls.length).toBe(1)
    expect(vaults.get(VAULT)!.balance).toBe(123_456_789n)
  })

  it('the smallest amount, one stroop', async () => {
    // Boundary: just above zero.
    await depositToVault({ contractId: VAULT, amountXlm: '0.0000001', ...as(OWNER) })
    expect((sent[0] as ReturnType<typeof decodeCall>).args[2]).toBe(1n)
  })

  it('returns the transaction hash it waited on', async () => {
    // Breaks: the UI linking to a transaction that is not the deposit.
    const hash = await depositToVault({ contractId: VAULT, amountXlm: '1', ...as(OWNER) })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rpc.getTransaction).toHaveBeenCalledWith(hash)
  })
})

// ── Queue ───────────────────────────────────────────────────────────────────

describe('queueVaultWithdrawal', () => {
  beforeEach(() => fund(100n * XLM))

  it('refuses a zero, negative or over-precise amount before anything is simulated', async () => {
    // Boundaries: zero and one past the precision limit.
    for (const amountXlm of ['0', '0.0000000', '-5', '1.00000001']) {
      await expect(queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm, ...as(OWNER) })).rejects.toThrow()
    }
    expect(rpc.simulateTransaction).not.toHaveBeenCalled()
    expectNothingSignedOrSent()
  })

  it('refuses a malformed recipient or vault', async () => {
    // Breaks: a withdrawal queued to an address nobody holds.
    await expect(queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT.slice(0, 55), amountXlm: '1', ...as(OWNER) })).rejects.toThrow('valid Stellar')
    await expect(queueVaultWithdrawal({ contractId: VAULT.slice(1), to: RECIPIENT, amountXlm: '1', ...as(OWNER) })).rejects.toThrow('valid Stellar')
    expectNothingSignedOrSent()
  })

  it('sends the recipient and the exact amount', async () => {
    // Breaks: a withdrawal paying someone else, or a different amount.
    await queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '2.5', ...as(OWNER) })
    const call = sent[0] as ReturnType<typeof decodeCall>
    expect(call).toMatchObject({ contractId: VAULT, fn: 'queue_withdrawal', args: [RECIPIENT, 25_000_000n] })
    expect(call.rawArgs[1].switch().name).toBe('scvI128')
  })

  it('allows exactly the available balance', async () => {
    // Boundary: the exact limit. Breaks: rounding turning "everything" into
    // one stroop too many, so a full withdrawal is impossible.
    await queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '100', ...as(OWNER) })
    expect(vaults.get(VAULT)!.reserved).toBe(100n * XLM)
  })

  it('refuses one stroop over the available balance, without signing', async () => {
    // Boundary: one over. Enforced by the contract (InsufficientAvailableBalance,
    // #8); the client must stop at simulation. Breaks: a refused transaction
    // signed and its fee paid, or the refusal swallowed.
    await expect(queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '100.0000001', ...as(OWNER) }))
      .rejects.toThrow(`#${E.InsufficientAvailableBalance}`)
    expectNothingSignedOrSent()
  })

  it('while another withdrawal is pending, only the unreserved remainder can be queued', async () => {
    // Boundary: a withdrawal while another is pending. The first reserves its
    // amount; a second for more than what is left is refused, one for exactly
    // what is left is allowed. Breaks: the same XLM promised twice.
    await queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '60', ...as(OWNER) })
    await expect(queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '40.0000001', ...as(OWNER) }))
      .rejects.toThrow(`#${E.InsufficientAvailableBalance}`)
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1)
    await queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '40', ...as(OWNER) })
    expect(vaults.get(VAULT)!.reserved).toBe(100n * XLM)
    await expect(queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '0.0000001', ...as(OWNER) }))
      .rejects.toThrow(`#${E.InsufficientAvailableBalance}`)
  })

  it('a cancelled withdrawal releases its reservation', async () => {
    // Breaks: cancelled withdrawals permanently locking funds.
    await queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '100', ...as(OWNER) })
    await cancelVaultWithdrawal({ contractId: VAULT, withdrawalId: 1, ...as(OWNER) })
    await expect(queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '100', ...as(OWNER) })).resolves.toBeTruthy()
  })

  it('refuses a key that is not the owner, without signing', async () => {
    // Enforced by the contract (owner.require_auth). Breaks: a stranger queueing
    // a withdrawal of someone else's vault.
    await expect(queueVaultWithdrawal({ contractId: VAULT, to: STRANGER.publicKey(), amountXlm: '1', ...as(STRANGER) })).rejects.toThrow('Auth')
    expectNothingSignedOrSent()
  })
})

// ── Cancel and execute ──────────────────────────────────────────────────────

describe('cancel and execute', () => {
  beforeEach(async () => {
    await fund(100n * XLM)
    await queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '10', ...as(OWNER) })
    rpc.sendTransaction.mockClear()
    txSign.mockClear()
  })

  it('send the withdrawal id as a u64', async () => {
    // Breaks: cancelling or executing a different withdrawal than the one shown.
    now += BigInt(DELAY)
    await executeVaultWithdrawal({ contractId: VAULT, withdrawalId: 1, ...as(OWNER) })
    const call = sent[sent.length - 1] as ReturnType<typeof decodeCall>
    expect(call).toMatchObject({ contractId: VAULT, fn: 'execute_withdrawal', args: [1n] })
    expect(call.rawArgs[0].switch().name).toBe('scvU64')
  })

  it('execute is refused one second before unlock, without signing', async () => {
    // The timelock — the vault's whole point. Boundary: unlock_at - 1.
    // Enforced by the contract (TimelockActive, #7). Breaks: funds leaving
    // before the delay the user chose.
    now += BigInt(DELAY) - 1n
    await expect(executeVaultWithdrawal({ contractId: VAULT, withdrawalId: 1, ...as(OWNER) })).rejects.toThrow(`#${E.TimelockActive}`)
    expectNothingSignedOrSent()
    expect(vaults.get(VAULT)!.balance).toBe(100n * XLM)
  })

  it('execute is allowed at exactly unlock time', async () => {
    // Boundary: unlock_at. Breaks: a withdrawal that can never be executed.
    now += BigInt(DELAY)
    await executeVaultWithdrawal({ contractId: VAULT, withdrawalId: 1, ...as(OWNER) })
    expect(vaults.get(VAULT)!.balance).toBe(90n * XLM)
    expect(vaults.get(VAULT)!.reserved).toBe(0n)
  })

  it('a withdrawal cannot be executed twice', async () => {
    // Breaks: one queued withdrawal paid out repeatedly.
    now += BigInt(DELAY)
    await executeVaultWithdrawal({ contractId: VAULT, withdrawalId: 1, ...as(OWNER) })
    txSign.mockClear()
    rpc.sendTransaction.mockClear()
    await expect(executeVaultWithdrawal({ contractId: VAULT, withdrawalId: 1, ...as(OWNER) })).rejects.toThrow(`#${E.WithdrawalNotPending}`)
    await expect(cancelVaultWithdrawal({ contractId: VAULT, withdrawalId: 1, ...as(OWNER) })).rejects.toThrow(`#${E.WithdrawalNotPending}`)
    expectNothingSignedOrSent()
  })

  it('a cancelled withdrawal cannot be executed, even after unlock', async () => {
    // Breaks: "cancel" not actually stopping the payment.
    await cancelVaultWithdrawal({ contractId: VAULT, withdrawalId: 1, ...as(OWNER) })
    now += BigInt(DELAY) * 2n
    txSign.mockClear()
    rpc.sendTransaction.mockClear()
    await expect(executeVaultWithdrawal({ contractId: VAULT, withdrawalId: 1, ...as(OWNER) })).rejects.toThrow(`#${E.WithdrawalNotPending}`)
    expectNothingSignedOrSent()
  })

  it('cancel is refused for a key that is not the owner', async () => {
    // Breaks: a stranger cancelling the owner's withdrawal.
    await expect(cancelVaultWithdrawal({ contractId: VAULT, withdrawalId: 1, ...as(STRANGER) })).rejects.toThrow('Auth')
    expectNothingSignedOrSent()
  })

  it('an unknown withdrawal id is refused', async () => {
    // Breaks: a stale UI acting on a withdrawal that does not exist.
    await expect(executeVaultWithdrawal({ contractId: VAULT, withdrawalId: 2, ...as(OWNER) })).rejects.toThrow(`#${E.WithdrawalNotFound}`)
    expectNothingSignedOrSent()
  })

  it('a withdrawal id that is not a whole number is refused before signing', async () => {
    // Partially valid input. Breaks: 1.5 or -1 coerced into some other id.
    for (const withdrawalId of [1.5, NaN]) {
      await expect(executeVaultWithdrawal({ contractId: VAULT, withdrawalId, ...as(OWNER) })).rejects.toThrow()
      await expect(cancelVaultWithdrawal({ contractId: VAULT, withdrawalId, ...as(OWNER) })).rejects.toThrow()
    }
    await expect(executeVaultWithdrawal({ contractId: VAULT, withdrawalId: -1, ...as(OWNER) })).rejects.toThrow()
    expectNothingSignedOrSent()
  })
})

// ── Submission ──────────────────────────────────────────────────────────────

describe('submission', () => {
  beforeEach(() => fund(10n * XLM))

  it('reports a rejected transaction instead of claiming success', async () => {
    // Breaks: the UI saying a withdrawal was queued when it was not.
    rpc.sendTransaction.mockResolvedValueOnce({ status: 'ERROR', hash: 'x', errorResult: undefined })
    await expect(queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '1', ...as(OWNER) })).rejects.toThrow('was rejected: unknown error')
  })

  it('reports a transaction that failed on chain', async () => {
    // Breaks: a failed execute shown as "sent".
    txOutcome = () => ({ status: sdk.rpc.Api.GetTransactionStatus.FAILED })
    await expect(queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '1', ...as(OWNER) })).rejects.toThrow('failed with status FAILED')
  })

  it('times out after 30 polls rather than waiting forever', async () => {
    // Breaks: a spinner that never ends while the transaction's fate is unknown.
    jest.useFakeTimers()
    txOutcome = () => ({ status: sdk.rpc.Api.GetTransactionStatus.NOT_FOUND })
    const result = queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '1', ...as(OWNER) }).catch((e) => e)
    for (let i = 0; i < 31; i++) await jest.advanceTimersByTimeAsync(1_000)
    const err = await result
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('timed out')
    expect(rpc.getTransaction).toHaveBeenCalledTimes(30)
  })
})

// ── Reading a vault ─────────────────────────────────────────────────────────

describe('fetchVaultDetails', () => {
  it('reads config, balances and every withdrawal, newest first', async () => {
    // Breaks: the screen the user decides to cancel from showing the wrong
    // state — a pending withdrawal missing, or amounts misread.
    await fund(100n * XLM)
    await queueVaultWithdrawal({ contractId: VAULT, to: RECIPIENT, amountXlm: '10', ...as(OWNER) })
    now += 5n
    await queueVaultWithdrawal({ contractId: VAULT, to: STRANGER.publicKey(), amountXlm: '0.0000001', ...as(OWNER) })
    await cancelVaultWithdrawal({ contractId: VAULT, withdrawalId: 2, ...as(OWNER) })
    txSign.mockClear()
    rpc.sendTransaction.mockClear()

    const d = await fetchVaultDetails(`  ${VAULT}  `)
    expect(d.contractId).toBe(VAULT)
    expect(d.config).toEqual({ owner: OWNER.publicKey(), token: NATIVE, delaySeconds: DELAY })
    expect(d.balanceStroops).toBe(100n * XLM)
    expect(d.balanceXlm).toBe('100')
    expect(d.reservedStroops).toBe(10n * XLM)
    expect(d.availableStroops).toBe(90n * XLM)
    expect(d.availableXlm).toBe('90')
    expect(d.withdrawals.map((w) => w.id)).toEqual([2, 1])
    expect(d.withdrawals[0]).toEqual({
      id: 2,
      to: STRANGER.publicKey(),
      amountStroops: 1n,
      amountXlm: '0.0000001',
      queuedAt: 1_005,
      unlockAt: 1_005 + DELAY,
      cancelled: true,
      executed: false,
    })
    expect(d.withdrawals[1]).toMatchObject({ id: 1, to: RECIPIENT, amountStroops: 10n * XLM, cancelled: false, executed: false })
    expectNothingSignedOrSent()
  })

  it('reads an empty vault', async () => {
    // Boundary: zero balance, zero withdrawals.
    const d = await fetchVaultDetails(VAULT)
    expect(d.balanceXlm).toBe('0')
    expect(d.withdrawals).toEqual([])
  })

  it('refuses a malformed address and an uninitialised contract', async () => {
    // Breaks: a blank or half-pasted id shown as an empty vault.
    await expect(fetchVaultDetails(VAULT.slice(0, 55))).rejects.toThrow('valid Stellar')
    await expect(fetchVaultDetails(NOT_A_VAULT)).rejects.toThrow('Could not read get_config')
  })

  it('refuses a delay too large to represent exactly, rather than rounding it', async () => {
    // Breaks: an unlock countdown that is silently wrong.
    vaults.get(VAULT)!.config!.delay_seconds = 2n ** 53n
    await expect(fetchVaultDetails(VAULT)).rejects.toThrow('safe integer')
  })
})
