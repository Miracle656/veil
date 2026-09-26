import { StellarToml } from '@stellar/stellar-sdk'

import { getRegisteredAsset, isRegisteredIssuer, type RegisteredAsset } from './assets'

/** Issuer stellar.toml metadata is refreshed once a day. */
export const ISSUER_TOML_TTL_MS = 24 * 60 * 60 * 1000

/** Logos larger than this are rejected. Half a megabyte is enough for a mark. */
export const MAX_ISSUER_LOGO_BYTES = 512 * 1024

const CACHE_PREFIX = 'veil_issuer_toml:v2:'
const FETCH_TIMEOUT_MS = 10_000

/** The currency fields this wallet reads from a SEP-1 stellar.toml. */
export interface IssuerCurrency {
  code?: string
  issuer?: string
  name?: string
  desc?: string
  image?: string
}

export interface IssuerTomlMetadata {
  code: string
  issuer: string
  /** Always the registry's verified issuer name. Fetched text never overwrites it. */
  issuerName: string
  name: string
  description: string | null
  imageUrl: string | null
  letter: string
  fetchedAt: number | null
  fromCache: boolean
}

export interface CacheStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

interface CachedIssuerMeta {
  code: string
  issuer: string
  name: string
  description: string | null
  imageUrl: string | null
  fetchedAt: number
}

type TomlDoc = { CURRENCIES?: IssuerCurrency[] }

/** First letter of the asset code, shown when there is no usable logo. */
export function letterAvatar(code: string): string {
  const trimmed = code.trim()
  return (trimmed[0] ?? '?').toUpperCase()
}

/** SEP-1 image URLs have to be HTTPS. Anything else is rejected. */
export function isHttpsImageUrl(url: string | undefined | null): url is string {
  if (!url) return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** True only for a positive length that fits under the logo cap. */
export function imageByteLengthAllowed(
  byteLength: number | null,
  maxBytes = MAX_ISSUER_LOGO_BYTES,
): boolean {
  return byteLength !== null && Number.isFinite(byteLength) && byteLength > 0 && byteLength <= maxBytes
}

/**
 * Picks the stellar.toml currency row for a registered issuer.
 * Rows whose issuer is not in the registry are ignored, so unverified
 * assets never contribute metadata.
 */
export function selectRegisteredCurrency(
  currencies: IssuerCurrency[] | undefined,
  code: string,
  issuer: string,
): IssuerCurrency | undefined {
  if (!isRegisteredIssuer(code, issuer)) return undefined
  if (!Array.isArray(currencies)) return undefined
  return currencies.find(
    (currency) =>
      currency?.code === code &&
      currency?.issuer === issuer &&
      isRegisteredIssuer(code, currency.issuer),
  )
}

function browserStore(): CacheStore {
  return {
    get(key) {
      try {
        if (typeof localStorage === 'undefined') return null
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(key, value)
      } catch {
        /* quota or blocked storage — the live result is still returned */
      }
    },
  }
}

function cacheKey(code: string, issuer: string): string {
  return `${CACHE_PREFIX}${code.toUpperCase()}:${issuer}`
}

function readCache(store: CacheStore, code: string, issuer: string): CachedIssuerMeta | null {
  const raw = store.get(cacheKey(code, issuer))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<CachedIssuerMeta>
    if (parsed.code?.toUpperCase() !== code.toUpperCase() || parsed.issuer !== issuer) return null
    if (typeof parsed.fetchedAt !== 'number' || !Number.isFinite(parsed.fetchedAt)) return null
    const imageUrl = isCachedImage(parsed.imageUrl) ? parsed.imageUrl : null
    return {
      code: parsed.code,
      issuer: parsed.issuer,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      description: typeof parsed.description === 'string' ? parsed.description : null,
      imageUrl,
      fetchedAt: parsed.fetchedAt,
    }
  } catch {
    return null
  }
}

function writeCache(store: CacheStore, entry: CachedIssuerMeta): void {
  store.set(cacheKey(entry.code, entry.issuer), JSON.stringify(entry))
}

function present(
  asset: RegisteredAsset,
  issuer: string,
  fields: {
    name?: string
    description?: string | null
    imageUrl?: string | null
    fetchedAt?: number | null
    fromCache: boolean
  },
): IssuerTomlMetadata {
  return {
    code: asset.code,
    issuer,
    issuerName: asset.issuerName,
    name: fields.name?.trim() || asset.name,
    description: fields.description?.trim() ? fields.description.trim() : null,
    imageUrl: isCachedImage(fields.imageUrl) ? fields.imageUrl : null,
    letter: letterAvatar(asset.code),
    fetchedAt: fields.fetchedAt ?? null,
    fromCache: fields.fromCache,
  }
}

/** Only the bounded image bytes are cached/rendered, never a remote URL. */
function isCachedImage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ISSUER_LOGO_BYTES * 4 / 3 + 100) return false
  const match = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(value)
  if (!match) return false
  try {
    return imageByteLengthAllowed(atob(match[1]).length)
  } catch {
    return false
  }
}

export interface BoundedImage {
  type: string
  bytes: Uint8Array<ArrayBuffer>
}

/** Reads an image response; a bad status, non-image type, or oversized body fails closed. */
export async function readBoundedImage(
  response: Response,
  maxBytes = MAX_ISSUER_LOGO_BYTES,
): Promise<BoundedImage | null> {
  if (!response.ok || !response.body) return null
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (!type || !/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(type)) return null
  const declared = response.headers.get('content-length')
  if (declared !== null && !imageByteLengthAllowed(Number(declared), maxBytes)) return null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let seen = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen += value.byteLength
      if (seen > maxBytes) return null
      chunks.push(value)
    }
  } finally {
    void Promise.resolve(reader.cancel()).catch(() => {})
  }
  if (!imageByteLengthAllowed(seen, maxBytes)) return null
  const bytes = new Uint8Array(seen)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { type, bytes }
}

function toDataUrl(image: BoundedImage): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(new Blob([image.bytes], { type: image.type }))
  })
}

interface ImageAttempt {
  dataUrl: string | null
  /** The request itself failed (network, CORS, timeout), as opposed to a rejected image. */
  unreachable: boolean
}

async function fetchImageDataUrl(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
  init: RequestInit,
): Promise<ImageAttempt> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
  } catch {
    clearTimeout(timeout)
    return { dataUrl: null, unreachable: true }
  }
  try {
    // Redirects are followed, but a hop off HTTPS rejects the logo.
    if (response.redirected && !isHttpsImageUrl(response.url)) return { dataUrl: null, unreachable: false }
    const image = await readBoundedImage(response, maxBytes)
    // Rendering these exact bytes avoids a second, unchecked image download.
    return { dataUrl: image ? await toDataUrl(image) : null, unreachable: false }
  } catch {
    return { dataUrl: null, unreachable: false }
  } finally {
    controller.abort()
    clearTimeout(timeout)
  }
}

/** Fetch once over HTTPS; unreadable, insecurely redirected, or oversized logos fail closed. */
export async function measureHttpsImage(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes = MAX_ISSUER_LOGO_BYTES,
): Promise<string | null> {
  if (!isHttpsImageUrl(url)) return null
  return (await fetchImageDataUrl(url, fetchImpl, maxBytes, { redirect: 'follow' })).dataUrl
}

/** Same-origin route that fetches a registered issuer's logo server-side. */
export const ISSUER_LOGO_PROXY_PATH = '/api/issuer-logo'

/**
 * Loads a registered issuer's logo. Many logo hosts send no CORS headers, so
 * the browser cannot read (and size-check) them directly; when the direct
 * request fails, the wallet's own route fetches the logo named in the
 * issuer's stellar.toml and applies the same checks. A logo that was fetched
 * but rejected is not retried through the route.
 */
export async function acceptIssuerLogo(
  code: string,
  issuer: string,
  url: string,
  fetchImpl: typeof fetch,
  maxBytes = MAX_ISSUER_LOGO_BYTES,
): Promise<string | null> {
  if (!isHttpsImageUrl(url)) return null
  const direct = await fetchImageDataUrl(url, fetchImpl, maxBytes, { redirect: 'follow' })
  if (!direct.unreachable) return direct.dataUrl
  const params = new URLSearchParams({ code, issuer })
  const proxied = await fetchImageDataUrl(`${ISSUER_LOGO_PROXY_PATH}?${params}`, fetchImpl, maxBytes, {
    redirect: 'error',
  })
  return proxied.dataUrl
}

/**
 * Loads display metadata from the registered issuer's stellar.toml.
 * Unregistered issuers are not fetched. The verified issuer name always
 * comes from the registry. A failed fetch reuses a cached copy, or the
 * registry text with a letter avatar when nothing is cached.
 */
export async function loadRegisteredIssuerMetadata(
  code: string,
  issuer: string,
  options: {
    now?: number
    store?: CacheStore
    resolveToml?: (domain: string) => Promise<TomlDoc>
    acceptImage?: (url: string) => Promise<string | null>
    ttlMs?: number
    fetchImpl?: typeof fetch
  } = {},
): Promise<IssuerTomlMetadata | null> {
  if (!isRegisteredIssuer(code, issuer)) return null
  // Stellar asset codes are case-sensitive even though registry lookup is not.
  const asset = getRegisteredAsset(code)
  // `homeDomain` is optional. The genuine USDT0 issuer publishes none while all
  // seven impostors of that code do, so its absence means only "no toml to
  // read" — the caller falls back to registry text and a letter avatar.
  const homeDomain = asset?.homeDomain?.trim()
  if (!asset || asset.code !== code || !homeDomain) return null

  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? ISSUER_TOML_TTL_MS
  const store = options.store ?? browserStore()
  const cached = readCache(store, code, issuer)
  if (cached && now >= cached.fetchedAt && now - cached.fetchedAt < ttlMs) {
    return present(asset, issuer, {
      name: cached.name,
      description: cached.description,
      imageUrl: cached.imageUrl,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
    })
  }

  const resolveToml =
    options.resolveToml ?? ((domain: string) => StellarToml.Resolver.resolve(domain, { timeout: FETCH_TIMEOUT_MS }))
  const acceptImage =
    options.acceptImage ??
    ((url: string) => acceptIssuerLogo(code, issuer, url, options.fetchImpl ?? fetch))

  try {
    const toml = await resolveToml(homeDomain)
    const currency = selectRegisteredCurrency(toml.CURRENCIES, code, issuer)
    let imageUrl: string | null = null
    if (typeof currency?.image === 'string' && isHttpsImageUrl(currency.image)) {
      try {
        imageUrl = await acceptImage(currency.image)
      } catch {
        imageUrl = null
      }
    }
    const entry: CachedIssuerMeta = {
      code: asset.code,
      issuer,
      name: typeof currency?.name === 'string' ? currency.name.trim() || asset.name : asset.name,
      description: typeof currency?.desc === 'string' ? currency.desc.trim() || null : null,
      imageUrl,
      fetchedAt: now,
    }
    writeCache(store, entry)
    return present(asset, issuer, { ...entry, fromCache: false })
  } catch {
    if (cached) {
      return present(asset, issuer, {
        name: cached.name,
        description: cached.description,
        imageUrl: cached.imageUrl,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
      })
    }
    return present(asset, issuer, { fromCache: false })
  }
}
