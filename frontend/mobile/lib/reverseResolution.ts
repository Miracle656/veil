/**
 * Mobile Reverse Federation Resolver (SEP-2 type=id)
 *
 * Resolves on-chain Stellar addresses to federation names for mobile client.
 * Returns null when unresolvable or during outages.
 */

export const DEFAULT_REVERSE_TTL_MS = 60_000

interface ReverseCacheEntry {
  name: string | null
  expiresAt: number
}

const reverseCache = new Map<string, ReverseCacheEntry>()

export function clearReverseCache(): void {
  reverseCache.clear()
}

export function invalidateReverseCache(address: string): void {
  reverseCache.delete(address.trim())
}

export interface ResolveReverseOptions {
  ttlMs?: number
  skipCache?: boolean
  fetchImpl?: typeof fetch
  federationServer?: string
}

export async function resolveReverseName(
  address: string,
  options?: ResolveReverseOptions,
): Promise<string | null> {
  const trimmed = (address || '').trim()
  if (!trimmed) return null

  const ttlMs = options?.ttlMs ?? DEFAULT_REVERSE_TTL_MS
  const skipCache = options?.skipCache ?? false
  const now = Date.now()

  if (!skipCache) {
    const entry = reverseCache.get(trimmed)
    if (entry && entry.expiresAt > now) {
      return entry.name
    }
    if (entry) {
      reverseCache.delete(trimmed)
    }
  }

  const fedServer = options?.federationServer ?? 'https://app.useveilapp.xyz/api/federation'
  const fetchFn = options?.fetchImpl ?? fetch

  try {
    const url = new URL(fedServer)
    url.searchParams.set('q', trimmed)
    url.searchParams.set('type', 'id')

    const res = await fetchFn(url.toString())
    if (!res.ok) {
      return null
    }

    const data = await res.json()
    const stellarAddress = data?.stellar_address
    if (typeof stellarAddress === 'string' && stellarAddress.trim()) {
      const name = stellarAddress.trim()
      if (ttlMs > 0) {
        reverseCache.set(trimmed, { name, expiresAt: now + ttlMs })
      }
      return name
    }
    return null
  } catch {
    return null
  }
}

export function formatAddressOrName(
  address: string,
  name?: string | null,
  formatter?: (addr: string) => string,
): string {
  if (name && name.trim()) {
    return name.trim()
  }
  return formatter ? formatter(address) : address
}
