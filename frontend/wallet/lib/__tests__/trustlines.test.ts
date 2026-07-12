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
