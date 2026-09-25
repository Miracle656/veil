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
  fetchIssuerFlags,
  getAssetControlDisclosure,
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
    const assets = await resolveAnchorAssets('   ', resolver)
    expect(assets).toEqual([])
    expect(called).toBe(false)
  })
})

describe('fetchIssuerFlags (#789)', () => {
  it('fetches and parses flags from Horizon response', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        flags: {
          auth_required: false,
          auth_revocable: true,
          auth_clawback_enabled: true,
          auth_immutable: false,
        },
      }),
    }) as unknown as typeof fetch

    const flags = await fetchIssuerFlags(ISSUER, 'https://horizon.stellar.org', mockFetch)
    expect(flags).toEqual({
      authRequired: false,
      authRevocable: true,
      authClawbackEnabled: true,
      authImmutable: false,
    })
  })

  it('returns null when horizon returns non-ok response', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as unknown as typeof fetch

    const flags = await fetchIssuerFlags(ISSUER, 'https://horizon.stellar.org', mockFetch)
    expect(flags).toBeNull()
  })

  it('returns null on blank issuer address without calling fetch', async () => {
    const mockFetch = jest.fn() as unknown as typeof fetch
    const flags = await fetchIssuerFlags('', 'https://horizon.stellar.org', mockFetch)
    expect(flags).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('getAssetControlDisclosure (#789)', () => {
  it('returns one-sentence disclosure when both revocable and clawback are enabled (e.g. USDT0)', () => {
    const disclosure = getAssetControlDisclosure({
      authRequired: false,
      authRevocable: true,
      authClawbackEnabled: true,
      authImmutable: false,
    })
    expect(disclosure).toBe(
      'The asset issuer can freeze this balance or claw it back; this is a property of the asset, not of Veil.'
    )
  })

  it('returns freeze disclosure when only revocable is enabled', () => {
    const disclosure = getAssetControlDisclosure({
      authRequired: false,
      authRevocable: true,
      authClawbackEnabled: false,
      authImmutable: false,
    })
    expect(disclosure).toBe(
      'The asset issuer can freeze this balance; this is a property of the asset, not of Veil.'
    )
  })

  it('returns clawback disclosure when only clawback is enabled', () => {
    const disclosure = getAssetControlDisclosure({
      authRequired: false,
      authRevocable: false,
      authClawbackEnabled: true,
      authImmutable: false,
    })
    expect(disclosure).toBe(
      'The asset issuer can claw this balance back; this is a property of the asset, not of Veil.'
    )
  })

  it('returns null when neither revocable nor clawback is enabled', () => {
    const disclosure = getAssetControlDisclosure({
      authRequired: true,
      authRevocable: false,
      authClawbackEnabled: false,
      authImmutable: false,
    })
    expect(disclosure).toBeNull()
  })

  it('returns null when flags is null', () => {
    expect(getAssetControlDisclosure(null)).toBeNull()
  })
})
