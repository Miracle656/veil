// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { ASSET_REGISTRY } from '../assets'
import { loadRegisteredIssuerMetadata, type CacheStore } from '../issuerToml'

const ETHERFUSE = ASSET_REGISTRY.CETES.issuer

function emptyStore(): CacheStore {
  return { get: () => null, set: () => {} }
}

describe('issuer TOML anchor metadata (#1060)', () => {
  it('captures anchor_asset and anchor_asset_type for a registered bond', async () => {
    const meta = await loadRegisteredIssuerMetadata('CETES', ETHERFUSE, {
      store: emptyStore(),
      resolveToml: async () => ({
        CURRENCIES: [
          {
            code: 'CETES',
            issuer: ETHERFUSE,
            name: 'Etherfuse CETES',
            desc: 'Mexico short-term debt.',
            anchor_asset: 'Mexican CETES Bonds',
            anchor_asset_type: 'bond',
          },
        ],
      }),
    })
    expect(meta).toMatchObject({
      issuerName: 'Etherfuse',
      anchorAsset: 'Mexican CETES Bonds',
      anchorAssetType: 'bond',
      fromCache: false,
    })
  })

  it('returns null anchors when the TOML omits them', async () => {
    const meta = await loadRegisteredIssuerMetadata('CETES', ETHERFUSE, {
      store: emptyStore(),
      resolveToml: async () => ({ CURRENCIES: [{ code: 'CETES', issuer: ETHERFUSE }] }),
    })
    expect(meta).toMatchObject({ anchorAsset: null, anchorAssetType: null })
  })

  it('keeps the registry facts and null anchors when the TOML fetch fails', async () => {
    const meta = await loadRegisteredIssuerMetadata('USTRY', ASSET_REGISTRY.USTRY.issuer, {
      store: emptyStore(),
      resolveToml: async () => {
        throw new Error('offline')
      },
    })
    expect(meta).toMatchObject({
      issuerName: 'Etherfuse',
      code: 'USTRY',
      anchorAsset: null,
      anchorAssetType: null,
      fromCache: false,
    })
  })
})
