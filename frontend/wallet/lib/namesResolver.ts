/**
 * SEP-2 Names & Federation Resolver for useveilapp.xyz.
 *
 * Implements dynamic on-chain holder resolution:
 * A name is bound to a CAP-46 NFT token ID. The federation endpoint answers by
 * reading who holds that token ID on-chain at the moment of the request, NEVER
 * by falling back to a stored or last-known address.
 */

export interface FederationNameEntry {
  name: string
  tokenId: string
  contractId: string
  /** Initial minter, kept for provenance only. Never returned as holder. */
  minterAddress?: string
}

/** Default domain managed by this federation server. */
export const VEIL_FEDERATION_DOMAIN = 'useveilapp.xyz'

/** Default server-side response cache TTL in seconds. */
export const FEDERATION_SERVER_CACHE_TTL_SEC = 60

/** Known registry entries for testing and default namespace mappings. */
export const DEFAULT_NAMES_REGISTRY: Record<string, FederationNameEntry> = {
  alice: {
    name: 'alice',
    tokenId: '1',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANFT1',
    minterAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWLT',
  },
  bob: {
    name: 'bob',
    tokenId: '2',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANFT1',
    minterAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBOTHR',
  },
}

export type OnChainHolderReader = (contractId: string, tokenId: string) => Promise<string | null>

export class UnreadableHolderError extends Error {
  constructor(public readonly name: string, public readonly tokenId: string, cause?: unknown) {
    super(`Cannot determine current on-chain holder for "${name}" (token #${tokenId}).`)
    this.name = 'UnreadableHolderError'
    if (cause) this.cause = cause
  }
}

export class NameNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(`Name "${name}" not found in registry.`)
    this.name = 'NameNotFoundError'
  }
}

export interface ResolveNameResult {
  stellar_address: string
  account_id: string
  memo_type?: string
  memo?: string
}

/**
 * Resolves a federation address (name*domain) to whoever holds the token right now on-chain.
 * Throws UnreadableHolderError if the chain cannot be read; never falls back to a stale address.
 */
export async function resolveFederationName(
  query: string,
  options?: {
    registry?: Record<string, FederationNameEntry>
    chainReader?: OnChainHolderReader
  },
): Promise<ResolveNameResult> {
  const parts = query.trim().split('*')
  if (parts.length !== 2) {
    throw new Error('invalid federation query format')
  }

  const rawName = parts[0].toLowerCase().trim()
  const domain = parts[1].toLowerCase().trim()

  const registry = options?.registry ?? DEFAULT_NAMES_REGISTRY
  const entry = registry[rawName]
  if (!entry) {
    throw new NameNotFoundError(rawName)
  }

  const reader = options?.chainReader ?? defaultChainHolderReader
  let currentHolder: string | null = null

  try {
    currentHolder = await reader(entry.contractId, entry.tokenId)
  } catch (err) {
    throw new UnreadableHolderError(rawName, entry.tokenId, err)
  }

  if (!currentHolder) {
    throw new UnreadableHolderError(rawName, entry.tokenId)
  }

  return {
    stellar_address: `${rawName}*${domain}`,
    account_id: currentHolder,
  }
}

/**
 * Reverse resolution: given an account ID, resolves the federation address currently held.
 */
export async function resolveFederationId(
  accountId: string,
  options?: {
    registry?: Record<string, FederationNameEntry>
    chainReader?: OnChainHolderReader
    domain?: string
  },
): Promise<ResolveNameResult> {
  const targetId = accountId.trim()
  const registry = options?.registry ?? DEFAULT_NAMES_REGISTRY
  const domain = options?.domain ?? VEIL_FEDERATION_DOMAIN
  const reader = options?.chainReader ?? defaultChainHolderReader

  for (const [name, entry] of Object.entries(registry)) {
    try {
      const holder = await reader(entry.contractId, entry.tokenId)
      if (holder === targetId) {
        return {
          stellar_address: `${name}*${domain}`,
          account_id: targetId,
        }
      }
    } catch {
      // Continue checking remaining entries
    }
  }

  throw new Error(`No federation name found for account ID "${targetId}".`)
}

/**
 * Default reader querying Soroban RPC or indexer.
 */
async function defaultChainHolderReader(contractId: string, tokenId: string): Promise<string | null> {
  const wraithUrl = process.env.NEXT_PUBLIC_WRAITH_URL?.trim()
  if (!wraithUrl) {
    throw new Error('Indexer / RPC not configured to read token holder on-chain.')
  }

  const res = await fetch(`${wraithUrl}/nfts/owners/${contractId}/${tokenId}`)
  if (!res.ok) {
    throw new Error(`Failed to read token owner: HTTP ${res.status}`)
  }

  const data = (await res.json()) as { owner?: string; toAddress?: string }
  return data.owner || data.toAddress || null
}
