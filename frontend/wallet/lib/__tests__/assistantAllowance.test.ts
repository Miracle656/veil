/**
 * @jest-environment node
 *
 * The assistant's allowance: how a spend is authorised, what the amounts and
 * the top-up plans may be, and when a plan is due.
 *
 * Addresses are made up here: contract ids from filler bytes, accounts from
 * throw-away keys. The XDR is built with the real SDK.
 */
import { Address, Keypair, Networks, StrKey, hash, scValToNative, xdr } from '@stellar/stellar-sdk'

import {
  ALLOWANCE_ERRORS,
  AllowanceSpendRefused,
  buildAllowanceSpendAuth,
  contractErrorCode,
  randomAuthNonce,
  refusalFor,
} from '../allowanceSpend'

jest.mock('../network', () => ({
  getNetwork: () => ({ networkPassphrase: 'Test SDF Network ; September 2015', rpcUrl: 'http://rpc.invalid', horizonUrl: 'http://horizon.invalid', name: 'testnet' }),
  getUsdcIssuer: () => 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
}))

import { grantProblem, MAX_ALLOWANCE_USDC, unitsToUsdc, usdcToUnits } from '../assistantAllowance'
import {
  afterProblem,
  afterSuccess,
  costUnits,
  duePlans,
  loadPlans,
  MAX_TOPUP_NGN,
  newPlan,
  normalisePhone,
  planProblem,
  savePlans,
  type TopUpPlan,
} from '../assistantTopUp'

const contractId = (fill: number) => StrKey.encodeContract(Buffer.alloc(32, fill))
const WALLET = contractId(1)
const TOKEN = contractId(2)
const SPENDER = Keypair.random().publicKey()
const TO = Keypair.random().publicKey()
const P = Networks.TESTNET

const build = (over: Partial<{ amount: bigint; nonce: xdr.Int64; validUntilLedger: number; to: string }> = {}) =>
  buildAllowanceSpendAuth(
    { wallet: WALLET, spender: SPENDER, token: TOKEN, to: over.to ?? TO, amount: over.amount ?? 12_500_000n },
    { networkPassphrase: P, nonce: over.nonce ?? xdr.Int64.fromString('42'), validUntilLedger: over.validUntilLedger ?? 1000 },
  )

describe('buildAllowanceSpendAuth', () => {
  it('asks the token to transfer from the wallet, to the destination, the exact amount', () => {
    const { transferArgs } = build()
    expect(Address.fromScVal(transferArgs[0]).toString()).toBe(WALLET)
    expect(Address.fromScVal(transferArgs[1]).toString()).toBe(TO)
    expect(scValToNative(transferArgs[2])).toBe(12_500_000n)
  })

  it('puts the spender address where a signature would go, on an entry for the wallet', () => {
    const cred = build().walletEntry.credentials().address()
    expect(Address.fromScAddress(cred.address()).toString()).toBe(WALLET)
    expect(Address.fromScVal(cred.signature()).toString()).toBe(SPENDER)
    expect(cred.nonce().toString()).toBe('42')
    expect(cred.signatureExpirationLedger()).toBe(1000)
  })

  it('roots the wallet entry at the token transfer and nothing else', () => {
    const root = build().walletEntry.rootInvocation()
    const fn = root.function().contractFn()
    expect(Address.fromScAddress(fn.contractAddress()).toString()).toBe(TOKEN)
    expect(fn.functionName().toString()).toBe('transfer')
    expect(root.subInvocations()).toHaveLength(0)
  })

  it('hashes the network, the nonce, the expiry and the transfer into the payload', () => {
    const { payload, walletEntry } = build()
    const expected = hash(
      xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: hash(Buffer.from(P)),
          nonce: xdr.Int64.fromString('42'),
          invocation: walletEntry.rootInvocation(),
          signatureExpirationLedger: 1000,
        }),
      ).toXDR(),
    )
    expect(payload.equals(expected)).toBe(true)
    // Any of them changing changes what is approved.
    expect(build({ amount: 12_500_001n }).payload.equals(payload)).toBe(false)
    expect(build({ nonce: xdr.Int64.fromString('43') }).payload.equals(payload)).toBe(false)
    expect(build({ validUntilLedger: 1001 }).payload.equals(payload)).toBe(false)
    expect(build({ to: Keypair.random().publicKey() }).payload.equals(payload)).toBe(false)
  })

  it('roots the spender entry at the wallet __check_auth, as the transaction source', () => {
    const { spenderEntry, payload, transferArgs } = build()
    expect(spenderEntry.credentials().switch().value).toBe(
      xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount().value,
    )
    const fn = spenderEntry.rootInvocation().function().contractFn()
    expect(Address.fromScAddress(fn.contractAddress()).toString()).toBe(WALLET)
    expect(fn.functionName().toString()).toBe('__check_auth')

    const [payloadArg, spenderArg, contexts] = fn.args()
    expect(Buffer.from(payloadArg.bytes()).equals(payload)).toBe(true)
    expect(Address.fromScVal(spenderArg).toString()).toBe(SPENDER)

    // One context: Contract { args, contract, fn_name }, keys in that order.
    const [context] = contexts.vec()!
    const [tag, body] = context.vec()!
    expect(tag.sym().toString()).toBe('Contract')
    const entries = body.map()!
    expect(entries.map((e) => e.key().sym().toString())).toEqual(['args', 'contract', 'fn_name'])
    expect(entries[0].val().vec()!.map((v) => v.toXDR('base64'))).toEqual(transferArgs.map((v) => v.toXDR('base64')))
    expect(Address.fromScVal(entries[1].val()).toString()).toBe(TOKEN)
    expect(entries[2].val().sym().toString()).toBe('transfer')
  })

  it('refuses a zero or negative amount before building anything', () => {
    expect(() => build({ amount: 0n })).toThrow(AllowanceSpendRefused)
    expect(() => build({ amount: -1n })).toThrow(AllowanceSpendRefused)
  })
})

describe('randomAuthNonce', () => {
  it('is a positive signed 64-bit number, and not the same twice', () => {
    const a = BigInt(randomAuthNonce().toString())
    const b = BigInt(randomAuthNonce().toString())
    expect(a >= 0n && a <= 0x7fffffffffffffffn).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('reading a refusal', () => {
  const event = (topics: xdr.ScVal[], data: xdr.ScVal) =>
    new xdr.DiagnosticEvent({
      inSuccessfulContractCall: false,
      event: new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: null,
        type: xdr.ContractEventType.diagnostic(),
        body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
      }),
    })
  const contractError = (code: number) => xdr.ScVal.scvError(xdr.ScError.sceContract(code))

  it('finds the wallet contract error among the diagnostic events', () => {
    const events = [
      event([xdr.ScVal.scvSymbol('fn_call')], xdr.ScVal.scvVoid()),
      event([xdr.ScVal.scvSymbol('error'), contractError(17)], xdr.ScVal.scvString('escalating')),
    ]
    expect(contractErrorCode(events)).toBe(17)
  })

  it('finds it when it is nested inside the event data', () => {
    const events = [event([xdr.ScVal.scvSymbol('error')], xdr.ScVal.scvVec([xdr.ScVal.scvString('x'), contractError(18)]))]
    expect(contractErrorCode(events)).toBe(18)
  })

  it('returns null when there is none, or no events at all', () => {
    expect(contractErrorCode([event([xdr.ScVal.scvSymbol('fn_call')], xdr.ScVal.scvVoid())])).toBeNull()
    expect(contractErrorCode(undefined)).toBeNull()
  })

  it('turns the codes proven on chain into sentences', () => {
    expect(refusalFor(17, 'HostError: Error(Auth, InvalidAction)').message).toBe(ALLOWANCE_ERRORS[17])
    expect(refusalFor(18, 'x').message).toMatch(/expired/)
    expect(refusalFor(17, 'x').code).toBe(17)
  })

  it('says nothing was sent when the reason is unknown, keeping the first line only', () => {
    const r = refusalFor(null, 'HostError: Error(Auth, InvalidAction)\nEvent log (newest first):\n 0: ...')
    expect(r.message).toMatch(/nothing was sent/)
    expect(r.message).not.toMatch(/Event log/)
  })
})

describe('allowance amounts', () => {
  it('reads typed USDC into the smallest unit without losing a digit', () => {
    expect(usdcToUnits('5')).toBe(50_000_000n)
    expect(usdcToUnits('2.50')).toBe(25_000_000n)
    expect(usdcToUnits('0.0000001')).toBe(1n)
    expect(usdcToUnits(' 12 ')).toBe(120_000_000n)
  })

  it('refuses what is not a plain positive amount', () => {
    for (const bad of ['', '0', '0.0', '-1', '1e3', '1.12345678', 'abc', '1,5', '.5']) {
      expect(usdcToUnits(bad)).toBeNull()
    }
  })

  it('writes the smallest unit back without trailing zeros', () => {
    expect(unitsToUsdc(50_000_000n)).toBe('5')
    expect(unitsToUsdc(25_000_000n)).toBe('2.5')
    expect(unitsToUsdc(1n)).toBe('0.0000001')
    expect(unitsToUsdc(0n)).toBe('0')
  })

  it('accepts a sensible grant and refuses a typo-sized or endless one', () => {
    expect(grantProblem('5', 7)).toBeNull()
    expect(grantProblem(String(MAX_ALLOWANCE_USDC), 30)).toBeNull()
    expect(grantProblem(String(MAX_ALLOWANCE_USDC + 1), 30)).toMatch(/or less/)
    expect(grantProblem('5', 0)).toMatch(/how long/)
    expect(grantProblem('5', 91)).toMatch(/how long/)
    expect(grantProblem('5', 1.5)).toMatch(/how long/)
    expect(grantProblem('nope', 7)).toMatch(/amount/)
  })
})

describe('top-up plans', () => {
  // A plainly made-up line: an MTN prefix followed by zeros.
  const PHONE = '08030000000'
  const DAY = 86_400_000
  const plan = (over: Partial<TopUpPlan> = {}): TopUpPlan => ({ ...newPlan(PHONE, 'MTN', 100, 7, 1_000, 'p1'), ...over })

  it('accepts a number as eleven digits and nothing else', () => {
    expect(normalisePhone('0803 000 0000')).toBe(PHONE)
    expect(normalisePhone('8030000000')).toBeNull()
    expect(normalisePhone('080300000001')).toBeNull()
    expect(normalisePhone('+2348030000000')).toBeNull()
  })

  it('refuses a plan with a wrong number, network, amount or interval', () => {
    expect(planProblem(PHONE, 'MTN', 100, 7)).toBeNull()
    expect(planProblem('12345', 'MTN', 100, 7)).toMatch(/11 digits/)
    expect(planProblem(PHONE, 'AIRTEL', 100, 7)).toMatch(/looks like MTN/)
    expect(planProblem(PHONE, 'NOPE', 100, 7)).toMatch(/network/)
    expect(planProblem(PHONE, 'MTN', 49, 7)).toMatch(/amount/)
    expect(planProblem(PHONE, 'MTN', MAX_TOPUP_NGN + 1, 7)).toMatch(/amount/)
    expect(planProblem(PHONE, 'MTN', 100.5, 7)).toMatch(/amount/)
    expect(planProblem(PHONE, 'MTN', 100, 3)).toMatch(/how often/)
  })

  it('makes a new plan due straight away', () => {
    expect(plan().nextRunAt).toBe(1_000)
    expect(duePlans([plan()], 1_000)).toHaveLength(1)
    expect(duePlans([plan()], 999)).toHaveLength(0)
  })

  it('lists due plans oldest first and leaves the rest', () => {
    const plans = [plan({ id: 'late', nextRunAt: 500 }), plan({ id: 'later', nextRunAt: 5_000 }), plan({ id: 'first', nextRunAt: 100 })]
    expect(duePlans(plans, 1_000).map((p) => p.id)).toEqual(['first', 'late'])
  })

  it('counts the next top-up from when it was paid, so a long absence pays once', () => {
    const monthLate = 1_000 + 30 * DAY
    const next = afterSuccess(plan(), monthLate, 'order-1')
    expect(next.nextRunAt).toBe(monthLate + 7 * DAY)
    expect(duePlans([next], monthLate)).toHaveLength(0)
    expect(next.lastOrderId).toBe('order-1')
  })

  it('clears an old problem once a top-up goes through', () => {
    const failed = afterProblem(plan(), 2_000, 'The allowance has ended.')
    expect(afterSuccess(failed, 3_000, 'order-2').lastProblem).toBeUndefined()
  })

  it('waits a day after a failed attempt and says why', () => {
    const failed = afterProblem(plan(), 2_000, 'That is more than the allowance has left.')
    expect(failed.nextRunAt).toBe(2_000 + DAY)
    expect(failed.lastProblem).toMatch(/allowance has left/)
    expect(duePlans([failed], 2_000 + DAY - 1)).toHaveLength(0)
  })

  it('keeps plans per wallet and drops a stored plan that no longer passes the rules', () => {
    const mem = new Map<string, string>()
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    savePlans(store, WALLET, [plan()])
    expect(loadPlans(store, WALLET)).toEqual([plan()])
    expect(loadPlans(store, contractId(9))).toEqual([])

    mem.set(`veil_topup_plans:${WALLET}`, JSON.stringify([plan(), { ...plan(), id: 'bad', amountNgn: 9_999_999 }, 'junk']))
    expect(loadPlans(store, WALLET).map((p) => p.id)).toEqual(['p1'])
    mem.set(`veil_topup_plans:${WALLET}`, 'not json')
    expect(loadPlans(store, WALLET)).toEqual([])
  })

  it('prices a top-up to seven decimals, as the Airtime screen does', () => {
    expect(costUnits(100, 1600)).toBe(625_000n) // 0.0625 USDC
    expect(costUnits(1000, 1533.27)).toBe(BigInt(Math.round(Number((1000 / 1533.27).toFixed(7)) * 1e7)))
    expect(() => costUnits(100, 0)).toThrow(/No price/)
  })
})

