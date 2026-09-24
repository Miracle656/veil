// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { ASSET_REGISTRY } from '../assets'
import {
  ISSUER_TOML_TTL_MS,
  MAX_ISSUER_LOGO_BYTES,
  imageByteLengthAllowed,
  isHttpsImageUrl,
  letterAvatar,
  loadRegisteredIssuerMetadata,
  measureHttpsImage,
  selectRegisteredCurrency,
  type CacheStore,
  type IssuerCurrency,
} from '../issuerToml'

const USDC = ASSET_REGISTRY.USDC
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const UNREGISTERED_ISSUER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'

function memoryStore(seed: Record<string, string> = {}): CacheStore & { data: Record<string, string> } {
  const data = { ...seed }
  return {
    data,
    get: (key) => (key in data ? data[key] : null),
    set: (key, value) => {
      data[key] = value
    },
  }
}

function response(byteLength: number, init: { ok?: boolean; length?: string | null } = {}): Response {
  const chunk = byteLength > 0 ? new Uint8Array(byteLength) : null
  let sent = false
  return {
    ok: init.ok ?? true,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-length' ? (init.length ?? null) : null),
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (!chunk || sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: chunk }
        },
        cancel: async () => {},
      }),
    },
  } as unknown as Response
}

describe('letterAvatar', () => {
  it('uses the first letter of the asset code', () => {
    expect(letterAvatar('usdc')).toBe('U')
    expect(letterAvatar('  USDY')).toBe('U')
    expect(letterAvatar('')).toBe('?')
  })
})

describe('image checks', () => {
  it('accepts only https urls under the size cap', () => {
    expect(isHttpsImageUrl('https://circle.com/usdc.png')).toBe(true)
    expect(isHttpsImageUrl('http://circle.com/usdc.png')).toBe(false)
    expect(isHttpsImageUrl('not a url')).toBe(false)
    expect(imageByteLengthAllowed(MAX_ISSUER_LOGO_BYTES)).toBe(true)
    expect(imageByteLengthAllowed(MAX_ISSUER_LOGO_BYTES + 1)).toBe(false)
    expect(imageByteLengthAllowed(0)).toBe(false)
    expect(imageByteLengthAllowed(null)).toBe(false)
  })

  it('rejects a non-https image without fetching it', async () => {
    const fetchImpl = jest.fn()
    await expect(measureHttpsImage('http://cdn.example/logo.png', fetchImpl)).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an oversized image from the content-length header', async () => {
    const fetchImpl = jest.fn(async () =>
      response(8, { length: String(MAX_ISSUER_LOGO_BYTES + 1) }),
    )
    await expect(
      measureHttpsImage('https://cdn.example/logo.png', fetchImpl),
    ).resolves.toBeNull()
  })

  it('rejects a body that grows past the cap', async () => {
    const fetchImpl = jest.fn(async () => response(64, { length: null }))
    await expect(measureHttpsImage('https://cdn.example/logo.png', fetchImpl, 16)).resolves.toBeNull()
  })

  it('keeps a small https image', async () => {
    const fetchImpl = jest.fn(async () => response(3, { length: '3' }))
    await expect(measureHttpsImage('https://cdn.example/logo.png', fetchImpl)).resolves.toBe(
      'https://cdn.example/logo.png',
    )
  })
})

describe('selectRegisteredCurrency', () => {
  const currencies: IssuerCurrency[] = [
    { code: 'USDC', issuer: UNREGISTERED_ISSUER, name: 'Fake', image: 'https://evil.example/a.png' },
    { code: 'USDC', issuer: USDC.issuer, name: 'USD Coin', desc: 'Circle dollar', image: 'https://circle.com/usdc.png' },
  ]

  it('ignores currency rows whose issuer is not registered', () => {
    expect(selectRegisteredCurrency(currencies, 'USDC', UNREGISTERED_ISSUER)).toBeUndefined()
  })

  it('matches the registered issuer, including the other registered USDC issuer', () => {
    expect(selectRegisteredCurrency(currencies, 'USDC', USDC.issuer)?.name).toBe('USD Coin')
    expect(selectRegisteredCurrency(currencies, 'usdc', TESTNET_USDC_ISSUER)?.issuer).toBe(USDC.issuer)
  })
})

describe('loadRegisteredIssuerMetadata', () => {
  const now = 1_700_000_000_000

  it('does not fetch toml for an unregistered issuer', async () => {
    const resolveToml = jest.fn()
    const store = memoryStore()
    await expect(
      loadRegisteredIssuerMetadata('USDC', UNREGISTERED_ISSUER, { now, store, resolveToml }),
    ).resolves.toBeNull()
    expect(resolveToml).not.toHaveBeenCalled()
    expect(store.data).toEqual({})
  })

  it('keeps the verified issuer name when the toml display name differs', async () => {
    const store = memoryStore()
    const meta = await loadRegisteredIssuerMetadata('USDC', USDC.issuer, {
      now,
      store,
      resolveToml: async () => ({
        CURRENCIES: [{ code: 'USDC', issuer: USDC.issuer, name: 'Not Circle', desc: 'A dollar token', image: 'http://insecure.example/logo.png' }],
      }),
      acceptImage: async (url) => (isHttpsImageUrl(url) ? url : null),
    })
    expect(meta).toMatchObject({
      issuerName: 'Circle',
      name: 'Not Circle',
      description: 'A dollar token',
      imageUrl: null,
      letter: 'U',
      fromCache: false,
    })
  })

  it('uses a fresh cache and does not hit the network', async () => {
    const key = `veil_issuer_toml:USDC:${USDC.issuer}`
    const store = memoryStore({
      [key]: JSON.stringify({
        code: 'USDC',
        issuer: USDC.issuer,
        name: 'Cached Coin',
        description: 'from cache',
        imageUrl: 'https://circle.com/usdc.png',
        fetchedAt: now - 1000,
        issuerName: 'Replaced by toml',
      }),
    })
    const resolveToml = jest.fn()
    const meta = await loadRegisteredIssuerMetadata('USDC', USDC.issuer, { now, store, resolveToml })
    expect(resolveToml).not.toHaveBeenCalled()
    expect(meta).toMatchObject({
      issuerName: 'Circle',
      name: 'Cached Coin',
      imageUrl: 'https://circle.com/usdc.png',
      fromCache: true,
    })
  })

  it('refreshes a stale cache and stores the new logo only when it is accepted', async () => {
    const key = `veil_issuer_toml:USDC:${USDC.issuer}`
    const store = memoryStore({
      [key]: JSON.stringify({
        code: 'USDC',
        issuer: USDC.issuer,
        name: 'Old',
        description: null,
        imageUrl: 'https://circle.com/old.png',
        fetchedAt: now - ISSUER_TOML_TTL_MS - 1,
      }),
    })
    const meta = await loadRegisteredIssuerMetadata('USDC', USDC.issuer, {
      now,
      store,
      resolveToml: async (domain) => {
        expect(domain).toBe('circle.com')
        return {
          CURRENCIES: [{ code: 'USDC', issuer: USDC.issuer, name: 'USD Coin', image: 'https://circle.com/usdc.png' }],
        }
      },
      acceptImage: async () => 'https://circle.com/usdc.png',
    })
    expect(meta).toMatchObject({ name: 'USD Coin', imageUrl: 'https://circle.com/usdc.png', fromCache: false, issuerName: 'Circle' })
    expect(JSON.parse(store.data[key]).fetchedAt).toBe(now)
  })

  it('falls back to a stale cache when the toml fetch fails', async () => {
    const key = `veil_issuer_toml:USDY:${ASSET_REGISTRY.USDY.issuer}`
    const store = memoryStore({
      [key]: JSON.stringify({
        code: 'USDY',
        issuer: ASSET_REGISTRY.USDY.issuer,
        name: 'Cached USDY',
        description: 'still here',
        imageUrl: 'https://ondo.finance/usdy.png',
        fetchedAt: now - ISSUER_TOML_TTL_MS - 5,
      }),
    })
    const meta = await loadRegisteredIssuerMetadata('USDY', ASSET_REGISTRY.USDY.issuer, {
      now,
      store,
      resolveToml: async () => {
        throw new Error('offline')
      },
    })
    expect(meta).toMatchObject({
      name: 'Cached USDY',
      issuerName: 'Ondo Finance',
      imageUrl: 'https://ondo.finance/usdy.png',
      letter: 'U',
      fromCache: true,
    })
  })

  it('falls back to the registry and a letter when offline with an empty cache', async () => {
    const meta = await loadRegisteredIssuerMetadata('USDC', USDC.issuer, {
      now,
      store: memoryStore(),
      resolveToml: async () => {
        throw new Error('offline')
      },
    })
    expect(meta).toMatchObject({
      name: 'USD Coin',
      issuerName: 'Circle',
      description: null,
      imageUrl: null,
      letter: 'U',
      fromCache: false,
    })
  })
})
