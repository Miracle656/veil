// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { ASSET_REGISTRY } from '../assets'
import {
  ISSUER_LOGO_PROXY_PATH,
  ISSUER_TOML_TTL_MS,
  MAX_ISSUER_LOGO_BYTES,
  acceptIssuerLogo,
  imageByteLengthAllowed,
  isHttpsImageUrl,
  letterAvatar,
  loadRegisteredIssuerMetadata,
  measureHttpsImage,
  selectRegisteredCurrency,
  type CacheStore,
  type IssuerCurrency,
} from '../issuerToml'

const LOGO = 'data:image/png;base64,AAAA'

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

function response(byteLength: number, init: { ok?: boolean; length?: string | null; type?: string } = {}): Response {
  const chunk = byteLength > 0 ? new Uint8Array(byteLength) : null
  let sent = false
  return {
    ok: init.ok ?? true,
    headers: {
      get: (name: string) => (name === 'content-type' ? (init.type ?? 'image/png') : name === 'content-length' ? (init.length ?? null) : null),
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

  it('rejects an https logo when the size check cannot be read', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const url = 'https://cdn.ondo.finance/tokens/logos/usdy_160x160.png'
    await expect(measureHttpsImage(url, fetchImpl)).resolves.toBeNull()
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
      LOGO,
    )
    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example/logo.png', expect.objectContaining({ redirect: 'follow', credentials: 'omit' }))
  })
})

describe('acceptIssuerLogo', () => {
  const direct = 'https://cdn.example/logo.png'

  it('uses the logo directly when the host allows it', async () => {
    const fetchImpl = jest.fn(async () => response(3, { length: '3' }))
    await expect(acceptIssuerLogo('USDC', USDC.issuer, direct, fetchImpl)).resolves.toBe(LOGO)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('falls back to the wallet route with only the code and issuer when the host is unreachable', async () => {
    const fetchImpl = jest.fn(async (url: RequestInfo | URL) => {
      if (String(url) === direct) throw new TypeError('Failed to fetch')
      return response(3, { length: '3' })
    })
    await expect(acceptIssuerLogo('USDC', USDC.issuer, direct, fetchImpl)).resolves.toBe(LOGO)
    const proxied = new URL(String(fetchImpl.mock.calls[1][0]), 'https://wallet.example')
    expect(proxied.pathname).toBe(ISSUER_LOGO_PROXY_PATH)
    expect(Object.fromEntries(proxied.searchParams)).toEqual({ code: 'USDC', issuer: USDC.issuer })
  })

  it('does not retry a logo that was fetched and rejected', async () => {
    const fetchImpl = jest.fn(async () => response(3, { length: String(MAX_ISSUER_LOGO_BYTES + 1) }))
    await expect(acceptIssuerLogo('USDC', USDC.issuer, direct, fetchImpl)).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects a logo redirected off https', async () => {
    const fetchImpl = jest.fn(async () =>
      Object.assign(response(3, { length: '3' }), { redirected: true, url: 'http://cdn.example/logo.png' }),
    )
    await expect(acceptIssuerLogo('USDC', USDC.issuer, direct, fetchImpl)).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps a logo redirected to another https url', async () => {
    const fetchImpl = jest.fn(async () =>
      Object.assign(response(3, { length: '3' }), { redirected: true, url: 'https://cdn2.example/logo.png' }),
    )
    await expect(acceptIssuerLogo('USDC', USDC.issuer, direct, fetchImpl)).resolves.toBe(LOGO)
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

  it('matches only the exact asset code and issuer', () => {
    expect(selectRegisteredCurrency(currencies, 'USDC', USDC.issuer)?.name).toBe('USD Coin')
    expect(selectRegisteredCurrency(currencies, 'USDC', TESTNET_USDC_ISSUER)).toBeUndefined()
    expect(selectRegisteredCurrency(currencies, 'usdc', USDC.issuer)).toBeUndefined()
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
    const key = `veil_issuer_toml:v2:USDC:${USDC.issuer}`
    const store = memoryStore({
      [key]: JSON.stringify({
        code: 'USDC',
        issuer: USDC.issuer,
        name: 'Cached Coin',
        description: 'from cache',
        imageUrl: LOGO,
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
      imageUrl: LOGO,
      fromCache: true,
    })
  })

  it('refreshes a stale cache and stores the new logo only when it is accepted', async () => {
    const key = `veil_issuer_toml:v2:USDC:${USDC.issuer}`
    const store = memoryStore({
      [key]: JSON.stringify({
        code: 'USDC',
        issuer: USDC.issuer,
        name: 'Old',
        description: null,
        imageUrl: LOGO,
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
      acceptImage: async () => LOGO,
    })
    expect(meta).toMatchObject({ name: 'USD Coin', imageUrl: LOGO, fromCache: false, issuerName: 'Circle' })
    expect(JSON.parse(store.data[key]).fetchedAt).toBe(now)
  })

  it('falls back to a stale cache when the toml fetch fails', async () => {
    const key = `veil_issuer_toml:v2:USDY:${ASSET_REGISTRY.USDY.issuer}`
    const store = memoryStore({
      [key]: JSON.stringify({
        code: 'USDY',
        issuer: ASSET_REGISTRY.USDY.issuer,
        name: 'Cached USDY',
        description: 'still here',
        imageUrl: LOGO,
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
      imageUrl: LOGO,
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


describe('metadata safety regressions', () => {
  it.each(['usdc', 'FAKE'])('never fetches an unregistered code %s', async (code) => {
    const resolveToml = jest.fn()
    expect(await loadRegisteredIssuerMetadata(code, USDC.issuer, { resolveToml })).toBeNull()
    expect(resolveToml).not.toHaveBeenCalled()
  })

  it('ignores malformed TOML rows without discarding valid metadata', async () => {
    const meta = await loadRegisteredIssuerMetadata('USDC', USDC.issuer, {
      store: memoryStore(),
      resolveToml: async () => ({ CURRENCIES: [null, { code: 123 }, {
        code: 'USDC', issuer: USDC.issuer, name: 12, desc: 'Valid description', image: 123,
      }] } as unknown as { CURRENCIES: IssuerCurrency[] }),
    })
    expect(meta).toMatchObject({ name: USDC.name, description: 'Valid description', imageUrl: null })
  })

  it('rejects an unchecked remote URL from cache', async () => {
    const now = Date.now()
    const store = memoryStore({ [`veil_issuer_toml:v2:USDC:${USDC.issuer}`]: JSON.stringify({
      code: 'USDC', issuer: USDC.issuer, name: 'Cached', fetchedAt: now,
      imageUrl: 'https://example.com/unchecked.png',
    }) })
    expect(await loadRegisteredIssuerMetadata('USDC', USDC.issuer, { now, store })).toMatchObject({ imageUrl: null })
  })

  it('refreshes at the exact expiry and does not trust future timestamps', async () => {
    const now = Date.now()
    for (const fetchedAt of [now - ISSUER_TOML_TTL_MS, now + 1]) {
      const store = memoryStore({ [`veil_issuer_toml:v2:USDC:${USDC.issuer}`]: JSON.stringify({
        code: 'USDC', issuer: USDC.issuer, fetchedAt,
      }) })
      const resolveToml = jest.fn(async () => ({}))
      await loadRegisteredIssuerMetadata('USDC', USDC.issuer, { now, store, resolveToml })
      expect(resolveToml).toHaveBeenCalledTimes(1)
    }
  })

  it('rejects empty, failed, non-image and unreadable responses', async () => {
    for (const result of [response(0), response(3, { ok: false }), response(3, { type: 'text/html' }),
      { ...response(3, { length: '3' }), body: null } as Response]) {
      expect(await measureHttpsImage('https://example.com/logo', async () => result)).toBeNull()
    }
  })

  it('aborts a stalled logo fetch and falls back', async () => {
    jest.useFakeTimers()
    try {
      const pending = measureHttpsImage('https://example.com/logo', (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }))
      await jest.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })
})
