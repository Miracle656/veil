import { Asset } from '@stellar/stellar-sdk'
import { SoroswapSDK, SupportedNetworks, SupportedProtocols, TradeType } from '@soroswap/sdk'
import { HORIZON_URL, NETWORK, NETWORK_PASSPHRASE, USDC_ISSUER } from './network.js'

/**
 * Asset prices, from the same place the Swap screen gets them.
 *
 * First choice is Soroswap's aggregator, which routes across Soroswap, Phoenix,
 * Aqua and the built-in DEX — the quote the Swap screen shows, so the agent and
 * the screen never disagree on a price. It needs SOROSWAP_API_KEY (server-side)
 * and is mainnet-only.
 *
 * Fallback is Horizon's strict-send path-finding over the built-in DEX (order
 * books and classic pools): free, keyless, on both networks, but blind to
 * smart-contract pools. Both replaced the Lens oracle, which charged per call
 * over x402 and made the agent hold a funded key of its own.
 */

export interface ResolvedAsset {
  /** Horizon's query form: "native" or "CODE:ISSUER". */
  horizon: string
  /** What to show a person: "XLM" or the code. */
  label: string
}

/**
 * Accepts "XLM", "native", "USDC" (resolved to the network's USDC issuer) or
 * "CODE:ISSUER". Anything else is refused: a bare code like "EURC" names no
 * particular asset on Stellar, where anyone can issue one with that code.
 */
export function resolveAsset(input: string): ResolvedAsset {
  const value = input.trim()
  const upper = value.toUpperCase()
  if (upper === 'XLM' || upper === 'NATIVE') return { horizon: 'native', label: 'XLM' }
  if (upper === 'USDC') return { horizon: `USDC:${USDC_ISSUER}`, label: 'USDC' }

  const [code, issuer] = value.split(':')
  if (code && issuer && /^G[A-Z2-7]{55}$/.test(issuer)) {
    return { horizon: `${code}:${issuer}`, label: code }
  }
  throw new Error(`Unknown asset "${input}". Use XLM, USDC, or CODE:ISSUER.`)
}

function sourceParams(asset: ResolvedAsset): Record<string, string> {
  if (asset.horizon === 'native') return { source_asset_type: 'native' }
  const [code, issuer] = asset.horizon.split(':')
  return {
    source_asset_type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
    source_asset_code: code,
    source_asset_issuer: issuer,
  }
}

export interface PriceQuote {
  pair: string
  /** Units of asset_b received for one unit of asset_a, at current liquidity. */
  price: number
  /** How many hops the best route takes (0 = direct). */
  hops: number
  source: 'soroswap' | 'stellar-dex'
  /** Venues the Soroswap route uses, e.g. ["soroswap", "aqua"]. */
  protocols?: string[]
}

/** Stellar amounts have 7 decimal places. */
const ONE_UNIT = 10_000_000n

/** The asset's Stellar Asset Contract id — what Soroswap quotes in. */
function contractIdOf(asset: ResolvedAsset): string {
  if (asset.horizon === 'native') return Asset.native().contractId(NETWORK_PASSPHRASE)
  const [code, issuer] = asset.horizon.split(':')
  return new Asset(code, issuer).contractId(NETWORK_PASSPHRASE)
}

async function soroswapPrice(a: ResolvedAsset, b: ResolvedAsset, apiKey: string): Promise<PriceQuote> {
  const client = new SoroswapSDK({ apiKey, defaultNetwork: SupportedNetworks.MAINNET })
  const quote = await client.quote({
    assetIn: contractIdOf(a),
    assetOut: contractIdOf(b),
    amount: ONE_UNIT,
    tradeType: TradeType.EXACT_IN,
    // The same venues the Swap screen quotes across (frontend/mobile/lib/soroswap.ts).
    protocols: [
      SupportedProtocols.SOROSWAP,
      SupportedProtocols.PHOENIX,
      SupportedProtocols.AQUA,
      SupportedProtocols.SDEX,
    ],
    slippageBps: 50,
  })
  if (!quote?.amountOut) throw new Error('no Soroswap route')
  const plan = quote.routePlan ?? []
  return {
    pair: `${a.label}/${b.label}`,
    price: Number(BigInt(quote.amountOut.toString())) / Number(ONE_UNIT),
    // Soroswap's path includes both end assets; Horizon's lists only the ones in
    // between. Count intermediates, so "hops" means the same from either source.
    hops: Math.max(0, ...plan.map((r) => r.swapInfo.path.length - 2)),
    source: 'soroswap',
    protocols: [...new Set(plan.map((r) => String(r.swapInfo.protocol)))],
  }
}

export async function getPrice(assetA: string, assetB: string): Promise<PriceQuote> {
  const a = resolveAsset(assetA)
  const b = resolveAsset(assetB)
  if (a.horizon === b.horizon) return { pair: `${a.label}/${b.label}`, price: 1, hops: 0, source: 'stellar-dex' }

  const apiKey = process.env.SOROSWAP_API_KEY?.trim()
  if (apiKey && NETWORK === 'mainnet') {
    try {
      return await soroswapPrice(a, b, apiKey)
    } catch (err) {
      // Soroswap down, rate-limited, or no route: the built-in DEX still has a
      // price, and a slightly narrower quote beats no answer.
      console.warn('[agent] Soroswap quote failed, using Horizon:', (err as Error).message)
    }
  }

  const params = new URLSearchParams({
    ...sourceParams(a),
    source_amount: '1',
    destination_assets: b.horizon,
  })
  const res = await fetch(`${HORIZON_URL}/paths/strict-send?${params}`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Price lookup failed (${res.status})`)

  const records: { destination_amount: string; path: unknown[] }[] =
    ((await res.json()) as any)?._embedded?.records ?? []
  if (records.length === 0) throw new Error(`No market between ${a.label} and ${b.label} right now`)

  const best = records.reduce((top, r) =>
    Number(r.destination_amount) > Number(top.destination_amount) ? r : top,
  )
  return {
    pair: `${a.label}/${b.label}`,
    price: Number(best.destination_amount),
    hops: best.path.length,
    source: 'stellar-dex',
  }
}
