/**
 * @jest-environment jsdom
 *
 * Tests for lib/multisig.ts: the web wallet's client for the M-of-N multisig
 * contract (contracts/multisig-wallet).
 *
 * Multisig exists so no single key moves money alone, and the whole feature
 * is a threshold check. Where each part is enforced:
 *
 *  - The contract counts approvals and pays out at `approvals >= threshold`.
 *    That rule — exactly-at pays, one-below does not, a repeated signature
 *    counts once, a non-owner does not count — is proven where it lives, by
 *    the Rust tests in contracts/multisig-wallet/src/lib.rs.
 *  - The client must count the same way when it reports progress
 *    (evaluateThreshold), refuse a configuration whose threshold can never be
 *    met or that repeats an owner (validateMultisigConfig), refuse a signature
 *    that cannot count before paying a fee for it, send the right arguments,
 *    and authorise exactly what it means to — nothing more. Those are proven
 *    here.
 *
 * What is real: the module, @stellar/stellar-sdk (building, XDR, ScVal,
 * prepareTransaction / assembleTransaction, authorizeEntry and its ed25519
 * signature). What is faked: the Soroban RPC (`rpc.Server.prototype`), backed
 * by a model of the contract as written in lib.rs. The fake verifies auth-entry
 * signatures cryptographically, so "this owner's signature was really applied"
 * is checked, not assumed. `Transaction.prototype.sign` is spied on and
 * asserted by count — jest prints a spy's arguments on failure, and sign()'s
 * argument is a Keypair.
 *
 * Every address is derived from a fixed seed, never typed by hand. No secret
 * is printed.
 */

import { webcrypto, createHash } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import * as sdk from '@stellar/stellar-sdk'
import * as networkModule from '../network'
import {
  validateMultisigConfig,
  evaluateThreshold,
  getOrFundFeePayer,
  deployAndInitMultisig,
  fetchMultisigDetails,
  proposeTransaction,
  signTransaction,
  getProposalsOnChain,
} from '../multisig'

const { Keypair, StrKey, Asset, Address, xdr, nativeToScVal, scValToNative } = sdk
const PASSPHRASE = networkModule.getNetwork().networkPassphrase

// ── Fixtures ────────────────────────────────────────────────────────────────

const seed = (label: string) => createHash('sha256').update(`veil #1207 ${label}`).digest()
const kp = (label: string) => Keypair.fromRawEd25519Seed(seed(label))
const A = kp('owner a')
const B = kp('owner b')
const C = kp('owner c')
const OUTSIDER = kp('outsider')
const FEE_PAYER = kp('fee payer')
const RECIPIENT = kp('recipient').publicKey()
const MULTISIG = StrKey.encodeContract(seed('multisig'))
const NATIVE = Asset.native().contractId(PASSPHRASE)
const XLM = 10_000_000n

// ── A model of contracts/multisig-wallet/src/lib.rs ─────────────────────────

interface Proposal { id: bigint; to: string; amount: bigint; approvals: string[]; executed: boolean }
interface State {
  owners: string[] | null
  threshold: number
  balance: bigint
  paid: Map<string, bigint>
  proposals: Proposal[]
}

let chain: State
/** Contract ids known to the fake. */
let contracts: Map<string, State>
/** Set to make the fake RPC hand back an auth entry beyond the call asked for. */
let tamper: null | 'sub-invocation' | 'other-function' | 'other-address'

function panic(msg: string): never {
  throw new Error(`HostError: Error(WasmVm, InvalidAction) "${msg}"`)
}

function state(id: string): State {
  const s = contracts.get(id)
  if (!s) panic('contract not found')
  return s
}

/** Contract logic, line for line with lib.rs. Returns the retval. */
function run(id: string, fn: string, args: any[], apply: boolean): sdk.xdr.ScVal {
  const s = state(id)
  if (id === NATIVE) return nativeToScVal(contracts.get(String(args[0]))?.balance ?? 0n, { type: 'i128' })
  const owners = () => s.owners ?? panic('not initialized')
  switch (fn) {
    case 'initialize': {
      const [list, threshold] = args as [string[], number]
      if (s.owners) panic('already initialized')
      if (threshold === 0) panic('threshold must be greater than 0')
      if (list.length < threshold) panic('threshold cannot exceed owners length')
      if (apply) { s.owners = list; s.threshold = threshold }
      return xdr.ScVal.scvVoid()
    }
    case 'propose_transaction': {
      const [caller, to, amount] = args as [string, string, bigint]
      if (!owners().includes(caller)) panic('caller is not an owner')
      const id = BigInt(s.proposals.length + 1)
      if (apply) s.proposals.push({ id, to, amount, approvals: [], executed: false })
      return nativeToScVal(id, { type: 'u64' })
    }
    case 'sign_transaction': {
      const [pid, signer] = args as [bigint, string]
      if (!owners().includes(signer)) panic('not an owner')
      const p = s.proposals.find((x) => x.id === pid) ?? panic('proposal not found')
      if (p.executed) panic('proposal already executed')
      const approvals = p.approvals.includes(signer) ? p.approvals : [...p.approvals, signer]
      const executes = approvals.length >= s.threshold
      if (executes && s.balance < p.amount) panic('balance is not sufficient')
      if (apply) {
        p.approvals = approvals
        if (executes) {
          p.executed = true
          s.balance -= p.amount
          s.paid.set(p.to, (s.paid.get(p.to) ?? 0n) + p.amount)
        }
      }
      return xdr.ScVal.scvVoid()
    }
    case 'get_owners':
      return xdr.ScVal.scvVec(owners().map((o) => nativeToScVal(o, { type: 'address' })))
    case 'get_threshold':
      owners()
      return nativeToScVal(s.threshold, { type: 'u32' })
    case 'get_proposal_count':
      return nativeToScVal(BigInt(s.proposals.length), { type: 'u64' })
    case 'get_proposal': {
      const p = s.proposals.find((x) => x.id === args[0]) ?? panic('proposal not found')
      return xdr.ScVal.scvMap(
        [
          ['amount', nativeToScVal(p.amount, { type: 'i128' })],
          ['approvals', xdr.ScVal.scvVec(p.approvals.map((a) => nativeToScVal(a, { type: 'address' })))],
          ['executed', xdr.ScVal.scvBool(p.executed)],
          ['id', nativeToScVal(p.id, { type: 'u64' })],
          ['to', nativeToScVal(p.to, { type: 'address' })],
        ].map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k as string), val: v as sdk.xdr.ScVal })),
      )
    }
    default:
      panic(`no function ${fn}`)
  }
}

/** Who the contract calls require_auth() on, for each write. */
function requiredAuth(fn: string, args: any[]): string | null {
  if (fn === 'propose_transaction') return args[0]
  if (fn === 'sign_transaction') return args[1]
  return null
}

function decode(tx: sdk.Transaction) {
  const op = tx.operations[0] as sdk.Operation.InvokeHostFunction
  if (op.func.switch().name !== 'hostFunctionTypeInvokeContract') return null
  const ic = op.func.invokeContract()
  return {
    op,
    contractId: Address.fromScAddress(ic.contractAddress()).toString(),
    fn: ic.functionName().toString(),
    args: ic.args().map((a) => scValToNative(a)),
    rawArgs: ic.args(),
    invocation: ic,
  }
}

function invocationFor(contractId: string, fn: string, rawArgs: sdk.xdr.ScVal[]) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({ contractAddress: new Address(contractId).toScAddress(), functionName: fn, args: rawArgs }),
    ),
    subInvocations: [],
  })
}

/** The entries simulation returns in recording mode. */
function recordedAuth(source: string, call: NonNullable<ReturnType<typeof decode>>) {
  const who = requiredAuth(call.fn, call.args)
  if (!who) return []
  let invocation = invocationFor(call.contractId, call.fn, call.rawArgs)
  let address = who
  if (tamper === 'other-function') invocation = invocationFor(call.contractId, 'propose_transaction', call.rawArgs)
  if (tamper === 'sub-invocation') {
    invocation = new xdr.SorobanAuthorizedInvocation({
      function: invocation.function(),
      subInvocations: [invocationFor(NATIVE, 'transfer', [
        nativeToScVal(who, { type: 'address' }),
        nativeToScVal(OUTSIDER.publicKey(), { type: 'address' }),
        nativeToScVal(1_000n * XLM, { type: 'i128' }),
      ])],
    })
  }
  if (tamper === 'other-address') address = OUTSIDER.publicKey()
  if (address === source && tamper !== 'other-address') {
    return [new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(), rootInvocation: invocation })]
  }
  return [new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
      address: new Address(address).toScAddress(),
      nonce: xdr.Int64.fromString('42'),
      signatureExpirationLedger: 0,
      signature: xdr.ScVal.scvVoid(),
    })),
    rootInvocation: invocation,
  })]
}

/** Enforcing mode: every address-credential entry must carry a valid signature. */
function verifyAuth(source: string, call: NonNullable<ReturnType<typeof decode>>) {
  const who = requiredAuth(call.fn, call.args)
  const entries = call.op.auth ?? []
  if (!who) return
  const entry = entries[0]
  if (!entry) panic('missing auth')
  const creds = entry.credentials()
  if (creds.switch() === xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount()) {
    if (who !== source) panic('source-account auth for a different address')
    return
  }
  const addr = creds.address()
  const signer = Address.fromScAddress(addr.address()).toString()
  if (signer !== who) panic('auth for the wrong address')
  const sigs = scValToNative(addr.signature()) as Array<{ public_key: Buffer; signature: Buffer }> | null
  if (!Array.isArray(sigs) || sigs.length === 0) panic('unsigned auth entry')
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
    networkId: createHash('sha256').update(PASSPHRASE).digest(),
    nonce: addr.nonce(),
    signatureExpirationLedger: addr.signatureExpirationLedger(),
    invocation: entry.rootInvocation(),
  }))
  const payload = createHash('sha256').update(preimage.toXDR()).digest()
  const ok = sigs.some((s) =>
    StrKey.encodeEd25519PublicKey(Buffer.from(s.public_key)) === signer
    && Keypair.fromPublicKey(signer).verify(payload, Buffer.from(s.signature)))
  if (!ok) panic('bad auth signature')
}

function simSuccess(auth: sdk.xdr.SorobanAuthorizationEntry[], retval: sdk.xdr.ScVal) {
  return {
    _parsed: true, id: '1', latestLedger: 1000, events: [],
    transactionData: new sdk.SorobanDataBuilder(), minResourceFee: '1000',
    result: { auth, retval },
  }
}

// ── RPC spies ───────────────────────────────────────────────────────────────

let rpc: Record<'getAccount' | 'simulateTransaction' | 'sendTransaction' | 'getTransaction' | 'getLatestLedger', jest.SpyInstance>
let txSign: jest.SpyInstance
let sent: Array<NonNullable<ReturnType<typeof decode>> | { deploy: sdk.Transaction }>
let effects: Map<string, () => void>
let txOutcome: () => any
let deployedId: string
let fetchMock: jest.Mock

const SUCCESS = sdk.rpc.Api.GetTransactionStatus.SUCCESS
const signCount = () => txSign.mock.calls.length
const sendCount = () => rpc.sendTransaction.mock.calls.length

function metaReturning(contractId: string, version = 'transactionMetaV4') {
  const sorobanMeta = () => ({ returnValue: () => ({ address: () => ({ contractId: () => StrKey.decodeContract(contractId) }) }) })
  return { switch: () => ({ name: version }), v3: () => ({ sorobanMeta }), v4: () => ({ sorobanMeta }) }
}

function freshState(owners: string[] | null, threshold: number, balance = 0n): State {
  return { owners, threshold, balance, paid: new Map(), proposals: [] }
}

beforeEach(() => {
  chain = freshState([A.publicKey(), B.publicKey(), C.publicKey()], 2, 1_000n * XLM)
  deployedId = StrKey.encodeContract(seed('freshly deployed multisig'))
  contracts = new Map([[MULTISIG, chain], [NATIVE, freshState(null, 0)]])
  tamper = null
  sent = []
  effects = new Map()
  txOutcome = () => ({ status: SUCCESS })
  localStorage.clear()
  sessionStorage.clear()
  fetchMock = jest.fn(async () => ({ ok: true }))
  Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true, writable: true })
  jest.spyOn(console, 'log').mockImplementation(() => {})

  const proto = sdk.rpc.Server.prototype as any
  rpc = {
    getAccount: jest.spyOn(proto, 'getAccount').mockImplementation(async (pub: any) => new sdk.Account(String(pub), '7')),
    getLatestLedger: jest.spyOn(proto, 'getLatestLedger').mockResolvedValue({ id: 'x', sequence: 5000, protocolVersion: '22' }),
    simulateTransaction: jest.spyOn(proto, 'simulateTransaction').mockImplementation(async (tx: any) => {
      const call = decode(tx)
      if (!call) return simSuccess([], xdr.ScVal.scvVoid()) // createContract
      try {
        const auth = (call.op.auth ?? []).length > 0 ? (verifyAuth(tx.source, call), call.op.auth!) : recordedAuth(tx.source, call)
        return simSuccess(auth, run(call.contractId, call.fn, call.args, false))
      } catch (e) {
        return { id: '1', latestLedger: 1000, events: [], error: (e as Error).message }
      }
    }),
    sendTransaction: jest.spyOn(proto, 'sendTransaction').mockImplementation(async (tx: any) => {
      const hash = tx.hash().toString('hex')
      const call = decode(tx)
      if (!call) {
        sent.push({ deploy: tx })
        contracts.set(deployedId, freshState(null, 0))
      } else {
        sent.push(call)
        effects.set(hash, () => run(call.contractId, call.fn, call.args, true))
      }
      return { status: 'PENDING', hash }
    }),
    getTransaction: jest.spyOn(proto, 'getTransaction').mockImplementation(async (hash: any) => {
      const outcome = txOutcome()
      if (outcome.status === SUCCESS) {
        effects.get(String(hash))?.()
        outcome.resultMetaXdr ??= metaReturning(deployedId)
      }
      effects.delete(String(hash))
      return outcome
    }),
  }
  txSign = jest.spyOn(sdk.Transaction.prototype, 'sign')
})

afterEach(() => {
  jest.restoreAllMocks()
})

const fee = { feePayerSecret: FEE_PAYER.secret() }

async function propose(amountXlm = '100', proposer = A) {
  await proposeTransaction({ contractId: MULTISIG, to: RECIPIENT, amountXlm, proposerSecret: proposer.secret(), ...fee })
}

async function sign(owner: sdk.Keypair, proposalId = 1) {
  return signTransaction({ contractId: MULTISIG, proposalId, signerSecret: owner.secret(), ...fee })
}

// ── Threshold evaluation ────────────────────────────────────────────────────

describe('evaluateThreshold', () => {
  const owners = [A.publicKey(), B.publicKey(), C.publicKey()]

  it('is met exactly at the threshold', () => {
    // Breaks: a legitimate 2-of-3 shown as still waiting.
    expect(evaluateThreshold([A.publicKey(), B.publicKey()], owners, 2)).toEqual({ approvals: 2, required: 2, met: true, remaining: 0 })
  })

  it('is not met one signature below it', () => {
    // The assertion that matters. Breaks: a 3-of-3 reported ready on two.
    expect(evaluateThreshold([A.publicKey(), B.publicKey()], owners, 3)).toEqual({ approvals: 2, required: 3, met: false, remaining: 1 })
    expect(evaluateThreshold([A.publicKey()], owners, 2).met).toBe(false)
    expect(evaluateThreshold([], owners, 1).met).toBe(false)
  })

  it('counts a repeated signature once', () => {
    // Breaks: one owner meeting a 2-of-3 alone by appearing twice.
    const r = evaluateThreshold([A.publicKey(), A.publicKey(), A.publicKey()], owners, 2)
    expect(r).toEqual({ approvals: 1, required: 2, met: false, remaining: 1 })
  })

  it('does not count a non-owner', () => {
    // Breaks: an outsider supplying the missing signature.
    expect(evaluateThreshold([A.publicKey(), OUTSIDER.publicKey()], owners, 2).met).toBe(false)
  })

  it('stops counting an owner who has been removed, so a proposal can drop back below the threshold', () => {
    // Removing a signer: their earlier approval must stop counting. Breaks: a
    // removed owner's signature still completing a payment.
    const approvals = [A.publicKey(), B.publicKey()]
    expect(evaluateThreshold(approvals, owners, 2).met).toBe(true)
    const afterRemovingB = [A.publicKey(), C.publicKey()]
    expect(evaluateThreshold(approvals, afterRemovingB, 2)).toEqual({ approvals: 1, required: 2, met: false, remaining: 1 })
  })

  it('refuses a threshold of zero instead of reporting it met', () => {
    // Breaks: "0 of N" read as approved with no signatures.
    expect(() => evaluateThreshold([], owners, 0)).toThrow('Invalid')
    expect(() => evaluateThreshold([], owners, 1.5)).toThrow('Invalid')
    expect(() => evaluateThreshold([], owners, NaN)).toThrow('Invalid')
  })
})

describe('validateMultisigConfig', () => {
  const three = [A.publicKey(), B.publicKey(), C.publicKey()]

  it('accepts a threshold of 1 and exactly the owner count', () => {
    // Boundaries: the smallest threshold and the largest.
    expect(validateMultisigConfig(three, 1)).toEqual(three)
    expect(validateMultisigConfig(three, 3)).toEqual(three)
    expect(validateMultisigConfig([` ${A.publicKey()} `], 1)).toEqual([A.publicKey()])
  })

  it('refuses one above the owner count — a multisig that can never pay', () => {
    // Also what removing a signer from an N-of-N would leave behind. Breaks:
    // funds locked in a contract no set of owners can move.
    expect(() => validateMultisigConfig(three, 4)).toThrow('cannot exceed')
    expect(() => validateMultisigConfig(three.slice(0, 2), 3)).toThrow('cannot exceed')
  })

  it('refuses a threshold of zero, or one that is not a whole number', () => {
    // Boundary: 0. Breaks: a multisig anyone can drain with no signatures.
    for (const t of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => validateMultisigConfig(three, t)).toThrow('whole number')
    }
  })

  it('refuses a repeated owner', () => {
    // FINDING, guarded here: the contract counts [A, A] as two owners but A's
    // approval once, so "2 of 2" with A twice can never execute, and [A, A, B]
    // at 2 needs both A and B though it reads as 2 of 3. Breaks: funds locked
    // behind a threshold that looks reachable.
    expect(() => validateMultisigConfig([A.publicKey(), A.publicKey()], 2)).toThrow('only once')
    expect(() => validateMultisigConfig([A.publicKey(), ` ${A.publicKey()}`, B.publicKey()], 2)).toThrow('only once')
  })

  it('refuses no owners, and an owner that is not an address', () => {
    // Breaks: a multisig with an owner nobody can ever sign as.
    expect(() => validateMultisigConfig([], 1)).toThrow('at least one owner')
    expect(() => validateMultisigConfig([A.publicKey().slice(0, 55)], 1)).toThrow('valid Stellar')
    expect(() => validateMultisigConfig([''], 1)).toThrow('valid Stellar')
  })
})

// ── Fee payer ───────────────────────────────────────────────────────────────

describe('getOrFundFeePayer', () => {
  it('uses an explicit key, then the session key, then a persisted one', async () => {
    // Breaks: fees charged to the wrong account.
    expect((await getOrFundFeePayer(FEE_PAYER.secret())).publicKey()).toBe(FEE_PAYER.publicKey())
    localStorage.setItem('veil_signer_secret', B.secret())
    sessionStorage.setItem('veil_signer_secret', A.secret())
    expect((await getOrFundFeePayer()).publicKey()).toBe(A.publicKey())
    sessionStorage.clear()
    expect((await getOrFundFeePayer()).publicKey()).toBe(B.publicKey())
    expect(fetchMock.mock.calls.length).toBe(0)
  })

  it('on testnet with no key, funds a temporary one from Friendbot', async () => {
    // Breaks: a first-time testnet user unable to do anything.
    const k = await getOrFundFeePayer()
    expect(fetchMock).toHaveBeenCalledWith(`https://friendbot.stellar.org?addr=${k.publicKey()}`)
    fetchMock.mockResolvedValueOnce({ ok: false })
    await expect(getOrFundFeePayer()).rejects.toThrow('Friendbot funding failed')
  })

  it('on mainnet with no key, refuses rather than inventing one', async () => {
    // Breaks: a fresh, unfunded mainnet key used to pay fees.
    jest.spyOn(networkModule, 'getNetwork').mockReturnValue({ ...networkModule.getNetwork(), name: 'mainnet' } as any)
    await expect(getOrFundFeePayer()).rejects.toThrow('On mainnet')
    expect(fetchMock.mock.calls.length).toBe(0)
  })
})

// ── Deploy ──────────────────────────────────────────────────────────────────

describe('deployAndInitMultisig', () => {
  const owners = [A.publicKey(), B.publicKey(), C.publicKey()]

  it('refuses a bad configuration before anything is funded, deployed or signed', async () => {
    // Breaks: a deploy paid for, then initialize refused — leaving an
    // uninitialised contract whose initialize anyone can call.
    for (const [o, t] of [[owners, 0], [owners, 4], [[A.publicKey(), A.publicKey()], 2], [[], 1]] as const) {
      await expect(deployAndInitMultisig({ owners: [...o], threshold: t, ...fee })).rejects.toThrow()
    }
    expect(rpc.getAccount.mock.calls.length).toBe(0)
    expect(fetchMock.mock.calls.length).toBe(0)
    expect(signCount()).toBe(0)
    expect(sendCount()).toBe(0)
  })

  it('deploys from the fee payer, then initialises with the owners, threshold and XLM', async () => {
    // FINDING, fixed: the deployer was passed as a bare string and the SDK
    // threw before building anything. Breaks: no multisig can be created.
    const id = await deployAndInitMultisig({ owners, threshold: 2, ...fee })
    expect(id).toBe(deployedId)

    const deploy = (sent[0] as { deploy: sdk.Transaction }).deploy
    const create = (deploy.operations[0] as sdk.Operation.InvokeHostFunction).func
    const args = create.switch().name === 'hostFunctionTypeCreateContractV2' ? create.createContractV2() : create.createContract()
    expect(Address.fromScAddress(args.contractIdPreimage().fromAddress().address()).toString()).toBe(FEE_PAYER.publicKey())
    expect(args.executable().wasmHash()).toHaveLength(32)

    const init = sent[1] as NonNullable<ReturnType<typeof decode>>
    expect(init).toMatchObject({ contractId: deployedId, fn: 'initialize', args: [owners, 2, NATIVE] })
    expect(init.rawArgs[1].switch().name).toBe('scvU32')
    expect(contracts.get(deployedId)).toMatchObject({ owners, threshold: 2 })
  })

  it('reads the contract id from v3 result meta as well', async () => {
    // Breaks: deploy "failing" on an RPC that still returns v3 meta.
    txOutcome = () => ({ status: SUCCESS, resultMetaXdr: metaReturning(deployedId, 'transactionMetaV3') })
    await expect(deployAndInitMultisig({ owners, threshold: 2, ...fee })).resolves.toBe(deployedId)
  })

  it('stops if the deploy is rejected or fails', async () => {
    // Breaks: initialize sent to a contract that does not exist.
    rpc.sendTransaction.mockResolvedValueOnce({ status: 'ERROR', hash: 'x', errorResult: null })
    await expect(deployAndInitMultisig({ owners, threshold: 2, ...fee })).rejects.toThrow('Deploy failed')
    expect(sendCount()).toBe(1)
    txOutcome = () => ({ status: 'FAILED' })
    await expect(deployAndInitMultisig({ owners, threshold: 2, ...fee })).rejects.toThrow('status: FAILED')
  })
})

// ── Propose ─────────────────────────────────────────────────────────────────

describe('proposeTransaction', () => {
  it('sends the proposing owner as caller, with their authorisation', async () => {
    // FINDING, fixed: the contract is propose_transaction(caller, to, amount)
    // and the caller was never sent, so every proposal failed. Breaks: no
    // payment can ever be proposed from the web wallet.
    await propose('2.5')
    const call = sent[0] as NonNullable<ReturnType<typeof decode>>
    expect(call).toMatchObject({ contractId: MULTISIG, fn: 'propose_transaction', args: [A.publicKey(), RECIPIENT, 25_000_000n] })
    expect(call.rawArgs[2].switch().name).toBe('scvI128')
    expect(chain.proposals).toHaveLength(1)
    expect(chain.proposals[0]).toMatchObject({ to: RECIPIENT, amount: 25_000_000n, approvals: [], executed: false })
  })

  it('works when the proposer is also the fee payer', async () => {
    // Source-account auth: the envelope signature is the authorisation.
    await proposeTransaction({ contractId: MULTISIG, to: RECIPIENT, amountXlm: '1', proposerSecret: A.secret(), feePayerSecret: A.secret() })
    expect(chain.proposals).toHaveLength(1)
    expect(rpc.getLatestLedger.mock.calls.length).toBe(0) // no auth entry to sign
  })

  it('refuses an amount that is zero, negative, exponential or over-precise, before anything else', async () => {
    // The amount used to go through parseFloat. Breaks: '1e3' proposed as
    // 1000 XLM, '-5' sent to the contract, or an eighth decimal rounded away.
    for (const amountXlm of ['0', '-5', '1e3', '0.00000001', 'abc', '']) {
      await expect(propose(amountXlm)).rejects.toThrow()
    }
    expect(rpc.simulateTransaction.mock.calls.length).toBe(0)
    expect(signCount()).toBe(0)
    expect(sendCount()).toBe(0)
  })

  it('refuses a malformed recipient', async () => {
    // Breaks: a proposal paying an address nobody holds.
    await expect(proposeTransaction({ contractId: MULTISIG, to: RECIPIENT.slice(0, 55), amountXlm: '1', proposerSecret: A.secret(), ...fee })).rejects.toThrow('valid Stellar')
    expect(sendCount()).toBe(0)
  })

  it('refuses a proposer who is not an owner, before funding or signing', async () => {
    // Breaks: a fee spent on a proposal the contract will refuse.
    await expect(propose('1', OUTSIDER)).rejects.toThrow('Only an owner')
    expect(rpc.getAccount.mock.calls.length).toBe(0)
    expect(signCount()).toBe(0)
    expect(sendCount()).toBe(0)
  })

  it('without a proposer key, uses the wallet signer, and refuses if there is none', async () => {
    // Breaks: a random Friendbot key proposing (never an owner) and failing late.
    await expect(proposeTransaction({ contractId: MULTISIG, to: RECIPIENT, amountXlm: '1', ...fee })).rejects.toThrow('owner key is required')
    sessionStorage.setItem('veil_signer_secret', B.secret())
    await proposeTransaction({ contractId: MULTISIG, to: RECIPIENT, amountXlm: '1', ...fee })
    expect((sent[0] as NonNullable<ReturnType<typeof decode>>).args[0]).toBe(B.publicKey())
  })

  it('reports a proposal that failed on chain instead of returning as if it worked', async () => {
    // FINDING, fixed: the on-chain status was never checked.
    txOutcome = () => ({ status: 'FAILED' })
    await expect(propose()).rejects.toThrow('Proposal failed on-chain with status: FAILED')
  })
})

// ── Sign ────────────────────────────────────────────────────────────────────

describe('signTransaction', () => {
  beforeEach(async () => {
    await propose('100')
    sent = []
    for (const spy of [txSign, rpc.sendTransaction, rpc.getAccount, rpc.simulateTransaction, rpc.getLatestLedger]) spy.mockClear()
  })

  it('applies the owner\'s signature to the auth entry, not just the envelope', async () => {
    // FINDING, fixed: the owner signed the envelope, which authorises nothing
    // for an address that is not the source, so signing failed on chain for
    // every owner but the fee payer. The fake verifies the ed25519 signature
    // over the entry. Breaks: no second owner can ever approve.
    await sign(A)
    expect(chain.proposals[0].approvals).toEqual([A.publicKey()])
    expect(signCount()).toBe(1) // the fee payer's envelope signature only
    const call = sent[0] as NonNullable<ReturnType<typeof decode>>
    expect(call).toMatchObject({ fn: 'sign_transaction', args: [1n, A.publicKey()] })
    expect(call.rawArgs[0].switch().name).toBe('scvU64')
  })

  it('one signature below the threshold does not pay, and says so', async () => {
    // The assertion the issue asks for, through the client: 2-of-3, one
    // signature. Breaks: money moving on one key.
    const r = await sign(A)
    expect(r).toEqual({ approvals: 1, required: 2, met: false, remaining: 1 })
    expect(chain.proposals[0].executed).toBe(false)
    expect(chain.paid.get(RECIPIENT)).toBeUndefined()
    expect(chain.balance).toBe(1_000n * XLM)
  })

  it('exactly at the threshold pays, once', async () => {
    // Breaks: a legitimate 2-of-3 blocked.
    await sign(A)
    const r = await sign(B)
    expect(r.met).toBe(true)
    expect(chain.proposals[0].executed).toBe(true)
    expect(chain.paid.get(RECIPIENT)).toBe(100n * XLM)
    expect(chain.balance).toBe(900n * XLM)
  })

  it('a repeated signature is refused before a fee is spent, and does not count', async () => {
    // Breaks: one owner "approving twice" toward a 2-of-3.
    await sign(A)
    txSign.mockClear()
    rpc.sendTransaction.mockClear()
    await expect(sign(A)).rejects.toThrow('already approved')
    expect(signCount()).toBe(0)
    expect(sendCount()).toBe(0)
    expect(chain.proposals[0].approvals).toEqual([A.publicKey()])
    expect(chain.proposals[0].executed).toBe(false)
  })

  it('a non-owner is refused before a fee is spent', async () => {
    // Breaks: an outsider's signature sent, paid for, and refused on chain.
    await expect(sign(OUTSIDER)).rejects.toThrow('not an owner')
    expect(rpc.getAccount.mock.calls.length).toBe(0)
    expect(signCount()).toBe(0)
    expect(sendCount()).toBe(0)
  })

  it('an executed proposal cannot be signed again', async () => {
    // Breaks: a late signature replaying a payment.
    await sign(A)
    await sign(B)
    txSign.mockClear()
    rpc.sendTransaction.mockClear()
    await expect(sign(C)).rejects.toThrow('already been executed')
    expect(sendCount()).toBe(0)
    expect(chain.paid.get(RECIPIENT)).toBe(100n * XLM)
  })

  it('refuses a proposal id that is not a positive whole number', async () => {
    // Partially valid input. Breaks: 1.5 or 0 coerced into some other proposal.
    for (const id of [0, -1, 1.5, NaN]) {
      await expect(sign(A, id)).rejects.toThrow('Invalid proposal id')
    }
    expect(rpc.simulateTransaction.mock.calls.length).toBe(0)
  })

  it('an owner who is also the fee payer signs through the envelope', async () => {
    // Source-account auth. Breaks: the fee-payer owner unable to approve.
    const r = await signTransaction({ contractId: MULTISIG, proposalId: 1, signerSecret: A.secret(), feePayerSecret: A.secret() })
    expect(r.approvals).toBe(1)
    expect(chain.proposals[0].approvals).toEqual([A.publicKey()])
  })

  describe('authorises nothing beyond the one call', () => {
    // The auth entries come from simulation, i.e. from the RPC. Breaks: a
    // hostile RPC getting an owner to sign a transfer out of their account.
    it('refuses an entry with a nested call', async () => {
      tamper = 'sub-invocation'
      await expect(sign(A)).rejects.toThrow('Refusing to sign')
      expect(sendCount()).toBe(0)
      expect(rpc.getLatestLedger.mock.calls.length).toBe(0)
    })

    it('refuses an entry for a different function', async () => {
      tamper = 'other-function'
      await expect(sign(A)).rejects.toThrow('Refusing to sign')
      expect(sendCount()).toBe(0)
    })

    it('refuses an entry for an address this wallet does not hold', async () => {
      tamper = 'other-address'
      await expect(sign(A)).rejects.toThrow('Refusing to sign')
      expect(sendCount()).toBe(0)
    })

    it('refuses the same on the fee-payer (source-account) path', async () => {
      // An envelope signature authorises every source-account entry, so a
      // nested call there would be signed silently.
      tamper = 'sub-invocation'
      await expect(signTransaction({ contractId: MULTISIG, proposalId: 1, signerSecret: A.secret(), feePayerSecret: A.secret() })).rejects.toThrow('Refusing to sign')
      expect(signCount()).toBe(0)
    })
  })

  it('reports a signature rejected or failed on chain', async () => {
    // FINDING, fixed: a FAILED status used to return as success.
    rpc.sendTransaction.mockResolvedValueOnce({ status: 'ERROR', hash: 'x', errorResult: null })
    await expect(sign(A)).rejects.toThrow('Signing failed')
    txOutcome = () => ({ status: 'FAILED' })
    await expect(sign(A)).rejects.toThrow('Signing failed on-chain')
    expect(chain.proposals[0].approvals).toEqual([])
  })
})

// ── Reads ───────────────────────────────────────────────────────────────────

describe('fetchMultisigDetails and getProposalsOnChain', () => {
  it('read the owners, threshold, balance and every proposal, newest first', async () => {
    // Breaks: the "2 of 3" and approvals an owner decides from being wrong.
    await propose('100')
    await propose('0.0000001', B)
    await sign(A, 1)

    const d = await fetchMultisigDetails(MULTISIG)
    expect(d).toEqual({ contractId: MULTISIG, owners: [A.publicKey(), B.publicKey(), C.publicKey()], threshold: 2, balanceXlm: '1000.0000000' })

    const p = await getProposalsOnChain(MULTISIG)
    expect(p.map((x) => x.id)).toEqual([2, 1])
    expect(p[1]).toEqual({ id: 1, to: RECIPIENT, amount: '100.0000000', approvals: [A.publicKey()], executed: false })
    expect(p[0].amount).toBe('0.0000001')
  })

  it('an unreadable multisig fails loudly, an unreadable proposal count reads as none', async () => {
    // Breaks: a missing multisig shown as one with no owners.
    const missing = StrKey.encodeContract(seed('nothing here'))
    await expect(fetchMultisigDetails(missing)).rejects.toThrow('get_owners')
    await expect(getProposalsOnChain(missing)).resolves.toEqual([])
  })
})
