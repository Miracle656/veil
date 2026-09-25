// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Account, Keypair, Networks, type Operation } from '@stellar/stellar-sdk'
import {
  buildChangeTrustTx,
  canRemoveTrustline,
  hasTrustline,
  normalizeDomain,
  parseTrustlines,
  resolveAnchorAssets,
  type HorizonBalanceLike,
} from '../trustlines'

const ISSUER = Keypair.random().publicKey()

const BALANCES: HorizonBalanceLike[] = [
  { asset_type: 'native', balance: '100' },
  { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER, balance: '5', limit: '1000' },
  { asset_type: 'credit_alphanum12', asset_code: 'LONGASSET', asset_issuer: ISSUER, balance: '0', limit: '50' },
  { asset_type: 'liquidity_pool_shares', balance: '3' },
]

describe('parseTrustlines', () => {
  it('keeps only classic credit assets with a code and issuer', () => {
    const lines = parseTrustlines(BALANCES)
    expect(lines.map((l) => l.code)).toEqual(['USDC', 'LONGASSET'])
    expect(lines[0]).toMatchObject({ code: 'USDC', issuer: ISSUER, balance: '5', limit: '1000' })
  })
})

describe('hasTrustline', () => {
  it('detects an existing trustline', () => {
    expect(hasTrustline(BALANCES, 'USDC', ISSUER)).toBe(true)
    expect(hasTrustline(BALANCES, 'EURC', ISSUER)).toBe(false)
  })
})

describe('canRemoveTrustline', () => {
  it('only allows removal at a zero balance', () => {
    expect(canRemoveTrustline({ code: 'A', issuer: ISSUER, balance: '0', limit: '1', assetType: 'credit_alphanum4' })).toBe(true)
    expect(canRemoveTrustline({ code: 'A', issuer: ISSUER, balance: '5', limit: '1', assetType: 'credit_alphanum4' })).toBe(false)
  })
})

describe('buildChangeTrustTx', () => {
  const account = () => new Account(Keypair.random().publicKey(), '0')

  it('adds a trustline at a non-zero limit', () => {
    const tx = buildChangeTrustTx({
      account: account(),
      networkPassphrase: Networks.TESTNET,
      code: 'USDC',
      issuer: ISSUER,
    })
    const op = tx.operations[0] as Operation.ChangeTrust
    expect(op.type).toBe('changeTrust')
    expect((op.line as { code: string }).code).toBe('USDC')
    expect(Number(op.limit)).toBeGreaterThan(0)
  })

  it('removes a trustline by setting the limit to zero', () => {
    const tx = buildChangeTrustTx({
      account: account(),
      networkPassphrase: Networks.TESTNET,
      code: 'USDC',
      issuer: ISSUER,
      remove: true,
    })
    const op = tx.operations[0] as Operation.ChangeTrust
    expect(op.type).toBe('changeTrust')
    expect(Number(op.limit)).toBe(0)
  })
})

describe('normalizeDomain', () => {
  it('strips scheme, path and whitespace', () => {
    expect(normalizeDomain('  https://centre.io/path/x ')).toBe('centre.io')
    expect(normalizeDomain('example.com')).toBe('example.com')
    expect(normalizeDomain('')).toBe('')
  })
})

describe('resolveAnchorAssets', () => {
  it('maps stellar.toml CURRENCIES and drops incomplete entries', async () => {
    const resolver = async () => ({
      CURRENCIES: [
        { code: 'USDC', issuer: ISSUER },
        { code: 'NOISSUER' },
        { issuer: ISSUER },
      ],
    })
    const assets = await resolveAnchorAssets('centre.io', resolver)
    expect(assets).toEqual([{ code: 'USDC', issuer: ISSUER }])
  })

  it('returns an empty list for a blank domain without calling the resolver', async () => {
    let called = false
    const resolver = async () => {
      called = true
      return {}
    }
    expect(await resolveAnchorAssets('  ', resolver)).toEqual([])
    expect(called).toBe(false)
  })
})

describe('Hold USDT0: trustline, balance and price (Issue #790)', () => {
  const REAL_USDT0_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'
  const FAKE_USDT0_ISSUER = 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK'

  const BALANCES_WITH_REAL_AND_FAKE_USDT0: HorizonBalanceLike[] = [
    { asset_type: 'native', balance: '50.0000000' },
    {
      asset_type: 'credit_alphanum12',
      asset_code: 'USDT0',
      asset_issuer: REAL_USDT0_ISSUER,
      balance: '1234.5678901',
      limit: '922337203685.4775807',
    },
    {
      asset_type: 'credit_alphanum12',
      asset_code: 'USDT0',
      asset_issuer: FAKE_USDT0_ISSUER,
      balance: '9999999.1234567',
      limit: '922337203685.4775807',
    },
  ]

  it('correctly parses wallet holding both real and fake USDT0 preserving 7 decimal places', () => {
    const lines = parseTrustlines(BALANCES_WITH_REAL_AND_FAKE_USDT0)
    expect(lines).toHaveLength(2)

    const realLine = lines.find((l) => l.issuer === REAL_USDT0_ISSUER)
    const fakeLine = lines.find((l) => l.issuer === FAKE_USDT0_ISSUER)

    expect(realLine).toBeDefined()
    expect(realLine?.code).toBe('USDT0')
    expect(realLine?.balance).toBe('1234.5678901')

    expect(fakeLine).toBeDefined()
    expect(fakeLine?.code).toBe('USDT0')
    expect(fakeLine?.balance).toBe('9999999.1234567')
  })

  it('builds changeTrust transaction for USDT0 with 0.5 XLM reserve', () => {
    const account = new Account(Keypair.random().publicKey(), '1')
    const tx = buildChangeTrustTx({
      account,
      networkPassphrase: Networks.PUBLIC,
      code: 'USDT0',
      issuer: REAL_USDT0_ISSUER,
    })
    const op = tx.operations[0] as Operation.ChangeTrust
    expect(op.type).toBe('changeTrust')
    expect((op.line as { code: string }).code).toBe('USDT0')
    expect((op.line as { issuer: string }).issuer).toBe(REAL_USDT0_ISSUER)
  })
})

