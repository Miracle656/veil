import { getRegisteredAsset, registeredAsset } from './assets.js'

const DEFAULT_LENS_URL = 'https://lens-ldtu.onrender.com'
const WINDOW = '24h'
const MAX_PAIRS = 100
const RESULT_LIMIT = 5

type LensPair = {
  assetA: string
  assetB: string
  pairKey: string
  volume24h: number
  lastUpdated?: string
}

type LensAsset = {
  code: string
  issuer: string | null
  status: 'verified' | 'unverified' | 'native'
  issuerName?: string
}

function assetDetails(value: string): LensAsset {
  const [rawCode, rawIssuer] = value.split(':')
  const code = rawCode.toUpperCase()
  if (code === 'XLM' && rawIssuer?.toLowerCase() === 'native') {
    return { code: 'XLM', issuer: null, status: 'native' }
  }

  // Lens pair keys carry the issuer. Never collapse an issued asset to its
  // code, even when the code matches an entry in Veil's registry.
  const issuer = rawIssuer ?? ''
  const entry = registeredAsset(code, 'mainnet') ?? registeredAsset(code, 'testnet')
  const legacyEntry = getRegisteredAsset(code)
  const registeredIssuer = entry?.issuer ?? (legacyEntry?.network === 'mainnet' || legacyEntry?.network === 'testnet' || legacyEntry?.network === 'all'
    ? legacyEntry.issuer
    : undefined)
  const isVerified = registeredIssuer === issuer && Boolean(issuer)
  const issuerName = isVerified
    ? (entry?.name ?? legacyEntry?.issuerName)
    : undefined

  return {
    code,
    issuer: issuer || 'unknown issuer',
    status: isVerified ? 'verified' : 'unverified',
    ...(issuerName ? { issuerName } : {}),
  }
}

function parsePair(pairKey: string): [string, string] | null {
  const parts = pairKey.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return [parts[0], parts[1]]
}

function graphQLAsset(value: string): string {
  const [code] = value.split(':')
  return code.toLowerCase() === 'native' ? 'XLM' : value
}

async function postGraphQL<T>(baseUrl: string, query: string, variables?: Record<string, string>): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Lens returned ${response.status}`)
  const result = await response.json() as { data?: T; errors?: unknown[] }
  if (!result.data || result.errors?.length) throw new Error('Lens returned an invalid market response')
  return result.data
}

/** Read Lens's measured 24-hour volume for its watched pairs. This never writes. */
export async function getTrendingActivity(lensUrl = process.env.LENS_URL?.trim() || DEFAULT_LENS_URL) {
  const listed = await postGraphQL<{ listPairs: string[] }>(lensUrl, '{ listPairs }')
  if (!Array.isArray(listed.listPairs)) throw new Error('Lens did not return watched pairs')

  const watchedPairs = listed.listPairs
    .slice(0, MAX_PAIRS)
    .map((pairKey) => ({ pairKey, assets: parsePair(pairKey) }))
    .filter((pair): pair is { pairKey: string; assets: [string, string] } => pair.assets !== null)

  if (watchedPairs.length === 0) {
    return {
      source: 'Lens GraphQL getPrice.volume24h',
      window: WINDOW,
      observedAt: new Date().toISOString(),
      pairsConsidered: 0,
      pairs: [],
    }
  }

  // One bounded GraphQL request keeps the read tool cheap and avoids a burst
  // of calls to the market service.
  const variableDefs = watchedPairs.flatMap((_, i) => [`$a${i}: String!`, `$b${i}: String!`]).join(', ')
  const selections = watchedPairs.map((_, i) =>
    `p${i}: getPrice(assetA: $a${i}, assetB: $b${i}) { assetA assetB pairKey volume24h lastUpdated }`,
  ).join('\n')
  const variables = watchedPairs.reduce<Record<string, string>>((all, pair, i) => {
    all[`a${i}`] = graphQLAsset(pair.assets[0])
    all[`b${i}`] = graphQLAsset(pair.assets[1])
    return all
  }, {})
  const query = `query TrendingActivity(${variableDefs}) { ${selections} }`
  const data = await postGraphQL<Record<string, LensPair | null>>(lensUrl, query, variables)

  const pairs = watchedPairs
    .map((pair, i) => {
      const measured = data[`p${i}`]
      if (!measured || !Number.isFinite(measured.volume24h) || measured.volume24h <= 0) return null
      return {
        pair: measured.pairKey || pair.pairKey,
        assets: pair.assets.map(assetDetails),
        volume: measured.volume24h,
        unit: 'Lens volume24h; Lens does not specify the denomination',
        window: WINDOW,
        lastUpdated: measured.lastUpdated,
      }
    })
    .filter((pair): pair is NonNullable<typeof pair> => pair !== null)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, RESULT_LIMIT)

  return {
    source: 'Lens GraphQL getPrice.volume24h',
    window: WINDOW,
    observedAt: new Date().toISOString(),
    pairsConsidered: watchedPairs.length,
    pairs,
  }
}
