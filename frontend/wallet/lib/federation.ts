export interface FederationResult {
  account_id: string
  memo_type?: string
  memo?: string
}

const cache: Record<string, FederationResult> = {}

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

export async function resolveFederation(address: string): Promise<FederationResult> {
  if (cache[address]) {
    return cache[address]
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
    const res = await fetch(tomlUrl)
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
    
    const res = await fetch(url.toString())
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

  cache[address] = result
  return result
}
