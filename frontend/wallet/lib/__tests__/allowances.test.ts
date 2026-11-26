/** @jest-environment node */
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { encodeApproveArgs } from '@veil/sdk'
import {
  ACTION_LABELS,
  CONTRACT_CAN_REVOKE,
  EXPIRY_TOLERANCE_SECS,
  STOP_REPLACEMENT,
  type AllowancePair,
  allowanceLedgerKey,
  allowanceStatus,
  approvalsInTransaction,
  availableActions,
  decodeAllowanceValue,
  fetchAllowances,
  loadTrackedPairs,
  parseUnits,
  recordApprovalsInXdr,
  reduceReplacement,
  trackPairs,
} from '../allowances'

// Real mainnet ids, written in full: a passkey wallet, the Blend pool, and the
// USDC and USDT0 SACs. A G-address spender is the USDC issuer account.
const WALLET = 'CDUS5S3AENE5QREEHCIEHGKMP6LMBDELUYB35ZSFYETXETN2674MXQHK'
const BLEND_POOL = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD'
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const USDT0_SAC = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF'
const ACCOUNT_SPENDER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

const NOW = 1_800_000_000n

function allowanceVal(amount: bigint, expiry: bigint | null): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('amount'), val: nativeToScVal(amount, { type: 'i128' }) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('expiry'),
      val: expiry === null ? xdr.ScVal.scvVoid() : nativeToScVal(expiry, { type: 'u64' }),
    }),
  ])
}

function entryXdr(spender: string, token: string, amount: bigint, expiry: bigint | null): string {
  const key = allowanceLedgerKey(WALLET, spender, token).contractData()
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: key.contract(),
      key: key.key(),
      durability: key.durability(),
      val: allowanceVal(amount, expiry),
    }),
  ).toXDR('base64')
}

interface Stored { spender: string; token: string; amount: bigint; expiry: bigint | null; liveUntil?: number }

/** A fake Soroban RPC holding `stored` allowances; records how many keys each call asked for. */
function fakeRpc(stored: Stored[], latestLedger = 1000) {
  const table = new Map(
    stored.map((s) => [
      allowanceLedgerKey(WALLET, s.spender, s.token).toXDR('base64'),
      { xdr: entryXdr(s.spender, s.token, s.amount, s.expiry), liveUntil: s.liveUntil ?? latestLedger + 100 },
    ]),
  )
  const calls: number[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body))
    expect(method).toBe('getLedgerEntries')
    calls.push(params.keys.length)
    const entries = (params.keys as string[])
      .filter((k) => table.has(k))
      .map((k) => ({ key: k, xdr: table.get(k)!.xdr, liveUntilLedgerSeq: table.get(k)!.liveUntil }))
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { latestLedger, entries } }), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('allowanceLedgerKey', () => {
  it('is the contract’s persistent DataKey::Allowance(AllowanceKey { spender, token })', () => {
    const key = allowanceLedgerKey(WALLET, BLEND_POOL, USDC_SAC).contractData()
    expect(Address.fromScAddress(key.contract()).toString()).toBe(WALLET)
    expect(key.durability()).toEqual(xdr.ContractDataDurability.persistent())

    const [tag, body] = key.key().vec()!
    expect(tag.sym().toString()).toBe('Allowance')
    const fields = body.map()!
    expect(fields.map((f) => f.key().sym().toString())).toEqual(['spender', 'token'])
    expect(Address.fromScVal(fields[0].val()).toString()).toBe(BLEND_POOL)
    expect(Address.fromScVal(fields[1].val()).toString()).toBe(USDC_SAC)
  })

  it('also accepts an account (G…) spender', () => {
    const key = allowanceLedgerKey(WALLET, ACCOUNT_SPENDER, USDC_SAC).contractData()
    const spender = key.key().vec()![1].map()![0].val()
    expect(Address.fromScVal(spender).toString()).toBe(ACCOUNT_SPENDER)
  })
})

describe('decodeAllowanceValue', () => {
  it('reads an exact i128 amount and a present expiry', () => {
    const big = 170_141_183_460_469_231_731_687_303_715_884_105_727n
    expect(decodeAllowanceValue(allowanceVal(big, 1_900_000_000n))).toEqual({ amount: big, expiry: 1_900_000_000n })
  })

  it('reads a missing expiry as null (never expires)', () => {
    expect(decodeAllowanceValue(allowanceVal(5n, null))).toEqual({ amount: 5n, expiry: null })
  })
})

describe('allowanceStatus — matches the deployed __check_auth', () => {
  it('stays active through the 60 s grace window and expires one second after', () => {
    const expiry = NOW
    expect(EXPIRY_TOLERANCE_SECS).toBe(60n)
    expect(allowanceStatus(10n, expiry, expiry + 60n)).toBe('active')
    expect(allowanceStatus(10n, expiry, expiry + 61n)).toBe('expired')
  })

  it('treats no expiry as never expiring', () => {
    expect(allowanceStatus(10n, null, 99_999_999_999n)).toBe('active')
  })

  it('marks a fully spent allowance as used up', () => {
    expect(allowanceStatus(0n, null, NOW)).toBe('used-up')
  })

  it('reports expiry before used-up: either way nothing can move', () => {
    expect(allowanceStatus(0n, 0n, NOW)).toBe('expired')
  })
})

describe('fetchAllowances', () => {
  it('lists found allowances, drops pairs with none, and keeps expired ones marked expired', async () => {
    const { fetchImpl } = fakeRpc([
      { spender: BLEND_POOL, token: USDC_SAC, amount: 50_000_000n, expiry: null },
      { spender: BLEND_POOL, token: USDT0_SAC, amount: 7n, expiry: NOW - 3600n },
    ])
    const pairs: AllowancePair[] = [
      { spender: BLEND_POOL, token: USDC_SAC },
      { spender: BLEND_POOL, token: USDT0_SAC },
      { spender: ACCOUNT_SPENDER, token: USDC_SAC },
    ]
    const result = await fetchAllowances('https://rpc.test', WALLET, pairs, { nowSecs: NOW, fetchImpl })

    expect(result).toEqual([
      { spender: BLEND_POOL, token: USDC_SAC, amount: 50_000_000n, expiry: null, status: 'active', archived: false },
      { spender: BLEND_POOL, token: USDT0_SAC, amount: 7n, expiry: NOW - 3600n, status: 'expired', archived: false },
    ])
  })

  it('flags an archived entry without treating it as gone', async () => {
    const { fetchImpl } = fakeRpc([{ spender: BLEND_POOL, token: USDC_SAC, amount: 1n, expiry: null, liveUntil: 900 }], 1000)
    const [a] = await fetchAllowances('https://rpc.test', WALLET, [{ spender: BLEND_POOL, token: USDC_SAC }], {
      nowSecs: NOW,
      fetchImpl,
    })
    expect(a.archived).toBe(true)
    expect(a.status).toBe('active')
  })

  it('sorts allowances that can still move money first', async () => {
    const { fetchImpl } = fakeRpc([
      { spender: ACCOUNT_SPENDER, token: USDC_SAC, amount: 1n, expiry: NOW - 999n },
      { spender: BLEND_POOL, token: USDC_SAC, amount: 0n, expiry: null },
      { spender: BLEND_POOL, token: USDT0_SAC, amount: 3n, expiry: null },
    ])
    const pairs = [
      { spender: ACCOUNT_SPENDER, token: USDC_SAC },
      { spender: BLEND_POOL, token: USDC_SAC },
      { spender: BLEND_POOL, token: USDT0_SAC },
    ]
    const result = await fetchAllowances('https://rpc.test', WALLET, pairs, { nowSecs: NOW, fetchImpl })
    expect(result.map((a) => a.status)).toEqual(['active', 'used-up', 'expired'])
  })

  it('deduplicates pairs and batches at 200 keys per request', async () => {
    const { fetchImpl, calls } = fakeRpc([])
    const many = Array.from({ length: 250 }, () => Keypair.random().publicKey()).map((spender) => ({
      spender,
      token: USDC_SAC,
    }))
    await fetchAllowances('https://rpc.test', WALLET, [...many, ...many], { nowSecs: NOW, fetchImpl })
    expect(calls).toEqual([200, 50])
  })

  it('surfaces an RPC failure instead of reporting no allowances', async () => {
    const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch
    await expect(
      fetchAllowances('https://rpc.test', WALLET, [{ spender: BLEND_POOL, token: USDC_SAC }], { fetchImpl: down }),
    ).rejects.toThrow(/HTTP 503/)
  })
})

describe('controls', () => {
  it('never offers remove, revoke or delete while the contract cannot do it', () => {
    expect(CONTRACT_CAN_REVOKE).toBe(false)
    for (const label of Object.values(ACTION_LABELS)) {
      expect(label).not.toMatch(/remov|revok|delet/i)
    }
  })

  it('offers controls only on an allowance that can still move funds', () => {
    expect(availableActions({ status: 'active' })).toEqual(['reduce', 'stop'])
    expect(availableActions({ status: 'expired' })).toEqual([])
    expect(availableActions({ status: 'used-up' })).toEqual([])
  })

  it('lowering keeps the expiry, so a time-limited allowance never becomes permanent', () => {
    expect(reduceReplacement({ amount: 100n, expiry: NOW + 86_400n }, 40n)).toEqual({ amount: 40n, expiry: NOW + 86_400n })
    expect(reduceReplacement({ amount: 100n, expiry: null }, 40n)).toEqual({ amount: 40n, expiry: null })
  })

  it('lowering refuses zero (the contract panics) and anything not lower', () => {
    expect(reduceReplacement({ amount: 100n, expiry: null }, 0n)).toHaveProperty('error')
    expect(reduceReplacement({ amount: 100n, expiry: null }, 100n)).toHaveProperty('error')
    expect(reduceReplacement({ amount: 100n, expiry: null }, 101n)).toHaveProperty('error')
  })

  it('stop-it-now is a positive amount the contract accepts, and is expired at any real ledger time', () => {
    expect(STOP_REPLACEMENT.amount > 0n).toBe(true)
    expect(allowanceStatus(STOP_REPLACEMENT.amount, STOP_REPLACEMENT.expiry, EXPIRY_TOLERANCE_SECS + 1n)).toBe('expired')
    expect(allowanceStatus(STOP_REPLACEMENT.amount, STOP_REPLACEMENT.expiry, NOW)).toBe('expired')
  })

  it('stop-it-now encodes to arguments the deployed approve accepts', () => {
    const [, , amount, expiry] = encodeApproveArgs(
      BLEND_POOL,
      USDC_SAC,
      STOP_REPLACEMENT.amount,
      STOP_REPLACEMENT.expiry ?? undefined,
    )
    // Compared by name: the SDK source may resolve its own copy of stellar-sdk.
    expect(amount.switch().name).toBe('scvI128')
    expect(expiry.switch().name).toBe('scvU64')
    expect(expiry.u64().toString()).toBe('0')
  })
})

describe('remembering approvals from signed dApp transactions', () => {
  function txWith(ops: xdr.Operation[]) {
    let builder = new TransactionBuilder(new Account(Keypair.random().publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.PUBLIC,
    })
    for (const op of ops) builder = builder.addOperation(op)
    return builder.setTimeout(30).build()
  }

  const approveOn = (contract: string, spender: string, token: string) =>
    new Contract(contract).call('approve', ...encodeApproveArgs(spender, token, 10n))

  it('finds approve calls on this wallet only', () => {
    const tx = txWith([
      approveOn(WALLET, BLEND_POOL, USDC_SAC),
      approveOn(BLEND_POOL, ACCOUNT_SPENDER, USDC_SAC), // a different contract's approve
      new Contract(WALLET).call('get_allowance', new Address(BLEND_POOL).toScVal(), new Address(USDT0_SAC).toScVal()),
    ])
    expect(approvalsInTransaction(tx.toEnvelope(), WALLET)).toEqual([{ spender: BLEND_POOL, token: USDC_SAC }])
  })

  it('looks inside a fee-bump envelope', () => {
    const inner = txWith([approveOn(WALLET, ACCOUNT_SPENDER, USDT0_SAC)])
    const bump = TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), '1000', inner, Networks.PUBLIC)
    expect(approvalsInTransaction(bump.toEnvelope(), WALLET)).toEqual([{ spender: ACCOUNT_SPENDER, token: USDT0_SAC }])
  })

  it('records them per wallet, deduplicated, and tolerates garbage', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    const xdrString = txWith([approveOn(WALLET, BLEND_POOL, USDC_SAC)]).toXDR()

    expect(recordApprovalsInXdr(store, WALLET, xdrString)).toEqual([{ spender: BLEND_POOL, token: USDC_SAC }])
    recordApprovalsInXdr(store, WALLET, xdrString)
    trackPairs(store, WALLET, [{ spender: ACCOUNT_SPENDER, token: USDT0_SAC }])
    expect(loadTrackedPairs(store, WALLET)).toEqual([
      { spender: BLEND_POOL, token: USDC_SAC },
      { spender: ACCOUNT_SPENDER, token: USDT0_SAC },
    ])

    expect(recordApprovalsInXdr(store, WALLET, 'not xdr')).toEqual([])
    expect(recordApprovalsInXdr(store, null, xdrString)).toEqual([])
    data.set(`veil_allowance_pairs:${WALLET}`, '{broken')
    expect(loadTrackedPairs(store, WALLET)).toEqual([])
  })
})

describe('parseUnits', () => {
  it('parses decimals into base units', () => {
    expect(parseUnits('1', 7)).toBe(10_000_000n)
    expect(parseUnits('0.0000001', 7)).toBe(1n)
    expect(parseUnits(' 12.5 ', 7)).toBe(125_000_000n)
  })

  it('rejects too many decimals and non-numbers', () => {
    expect(parseUnits('0.00000001', 7)).toBeNull()
    expect(parseUnits('-1', 7)).toBeNull()
    expect(parseUnits('1e3', 7)).toBeNull()
    expect(parseUnits('', 7)).toBeNull()
  })
})
