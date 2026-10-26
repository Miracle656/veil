export interface FederationResult {
  account_id: string
  memo_type?: string
  memo?: string
}

export const DEFAULT_FEDERATION_CACHE_TTL_MS = 60_000 // 60 seconds

interface CacheEntry {
  result: FederationResult
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

/** Clears all cached federation resolutions. Useful for testing and cache invalidation. */
export function clearFederationCache(): void {
  cache.clear()
}

/** Removes an expired or specific address from the federation cache. */
export function invalidateFederationCache(address: string): void {
  cache.delete(address)
}

export interface ResolveFederationOptions {
  ttlMs?: number
  skipCache?: boolean
  fetchImpl?: typeof fetch
}

function parseToml(tomlText: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = tomlText.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const parts = trimmed.split('=')
    if (parts.length >= 2) {
      const key = parts[0].trim()
      let value = parts.slice(1).join('=').trim()
      // Remove surrounding quotes if any
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      result[key] = value
    }
  }
  return result
}

export async function resolveFederation(
  address: string,
  options?: ResolveFederationOptions,
): Promise<FederationResult> {
  const ttlMs = options?.ttlMs ?? DEFAULT_FEDERATION_CACHE_TTL_MS
  const skipCache = options?.skipCache ?? false
  const fetchFn = options?.fetchImpl ?? fetch
  const now = Date.now()

  if (!skipCache) {
    const entry = cache.get(address)
    if (entry) {
      if (entry.expiresAt > now) {
        return entry.result
      }
      // Expired: delete before fetching so any subsequent error never serves a stale hit
      cache.delete(address)
    }
  }

  const parts = address.split('*')
  if (parts.length !== 2) {
    throw new Error('invalid federation address')
  }

  const name = parts[0]
  const domain = parts[1]
  if (!name || !domain) {
    throw new Error('invalid federation address')
  }

  let tomlText: string
  try {
    const tomlUrl = `https://${domain}/.well-known/stellar.toml`
    const res = await fetchFn(tomlUrl)
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('address not found')
      }
      throw new Error('federation server unreachable')
    }
    tomlText = await res.text()
  } catch (err) {
    if (err instanceof Error && err.message === 'address not found') {
      throw err
    }
    throw new Error('federation server unreachable')
  }

  const toml = parseToml(tomlText)
  const fedServer = toml['FEDERATION_SERVER']
  if (!fedServer) {
    throw new Error('federation server unreachable')
  }

  // Ensure absolute URL
  let queryUrl = fedServer
  if (!queryUrl.startsWith('http://') && !queryUrl.startsWith('https://')) {
    queryUrl = `https://${queryUrl}`
  }

  let result: FederationResult
  try {
    const url = new URL(queryUrl)
    url.searchParams.set('q', address)
    url.searchParams.set('type', 'name')
    
    const res = await fetchFn(url.toString())
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('address not found')
      }
      throw new Error('federation server unreachable')
    }
    result = await res.json()
  } catch (err) {
    if (err instanceof Error && err.message === 'address not found') {
      throw err
    }
    throw new Error('federation server unreachable')
  }

  if (!result || !result.account_id) {
    throw new Error('address not found')
  }

  if (ttlMs > 0) {
    cache.set(address, {
      result,
      expiresAt: now + ttlMs,
    })
  }

  return result
}
