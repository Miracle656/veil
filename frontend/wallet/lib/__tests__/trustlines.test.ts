// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Account, Keypair, Networks, type Operation } from '@stellar/stellar-sdk'
import {
  buildChangeTrustTx,
  calculateSpendableAfterTrustline,
  canRemoveTrustline,
  getRemovalRefusalReason,
  hasTrustline,
  normalizeDomain,
  parseTrustlines,
  resolveAnchorAssets,
  TRUSTLINE_RESERVE_XLM,
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

describe('canRemoveTrustline & getRemovalRefusalReason', () => {
  it('only allows removal at a zero balance', () => {
    expect(canRemoveTrustline({ code: 'A', issuer: ISSUER, balance: '0', limit: '1', assetType: 'credit_alphanum4' })).toBe(true)
    expect(canRemoveTrustline({ code: 'A', issuer: ISSUER, balance: '5', limit: '1', assetType: 'credit_alphanum4' })).toBe(false)
  })

  it('provides detailed refusal reason when balance is non-zero', () => {
    const refusal = getRemovalRefusalReason({ code: 'USDC', issuer: ISSUER, balance: '12.5000000', limit: '100', assetType: 'credit_alphanum4' })
    expect(refusal).toBe('Cannot remove trustline for USDC: balance is 12.5000000 (must be 0 to remove and reclaim 0.5 XLM reserve).')
  })

  it('returns null refusal reason when balance is zero', () => {
    const refusal = getRemovalRefusalReason({ code: 'USDC', issuer: ISSUER, balance: '0', limit: '100', assetType: 'credit_alphanum4' })
    expect(refusal).toBeNull()
  })
})

describe('calculateSpendableAfterTrustline', () => {
  it('computes 0.5 XLM reserve per trustline and remaining spendable balance', () => {
    expect(TRUSTLINE_RESERVE_XLM).toBe(0.5)
    const res = calculateSpendableAfterTrustline('3.5000000', 1)
    expect(res.reserveCost).toBe(0.5)
    expect(res.currentSpendable).toBe(3.5)
    expect(res.projectedSpendable).toBe(3.0)
    expect(res.canAfford).toBe(true)
  })

  it('flags canAfford as false when spendable balance is less than reserve cost', () => {
    const res = calculateSpendableAfterTrustline('0.3000000', 1)
    expect(res.reserveCost).toBe(0.5)
    expect(res.currentSpendable).toBe(0.3)
    expect(res.projectedSpendable).toBe(0)
    expect(res.canAfford).toBe(false)
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
