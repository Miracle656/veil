import { Networks } from '@stellar/stellar-sdk'
import { getNetwork } from '@/lib/network'
import {
  SoroswapSDK,
  SupportedNetworks,
  SupportedProtocols,
  TradeType,
  type QuoteResponse,
} from '@soroswap/sdk'
import { quoteMismatch } from '@/lib/swapAssets'

const net = getNetwork()
const IS_TESTNET = net.networkPassphrase === Networks.TESTNET

const SOROSWAP_API_KEY = process.env.NEXT_PUBLIC_SOROSWAP_API_KEY?.trim() || ''

function getSoroswapClient(): SoroswapSDK | null {
  if (!SOROSWAP_API_KEY) {
    return null
  }
  return new SoroswapSDK({
    apiKey: SOROSWAP_API_KEY,
    defaultNetwork: IS_TESTNET ? SupportedNetworks.TESTNET : SupportedNetworks.MAINNET,
  })
}

export interface SwapQuote {
  amountOut: string
  priceImpact: number
  path: string[]
  protocols: string[]
  rawQuote: QuoteResponse
  ttl: number // unix timestamp when the quote expires
}

export interface SwapParams {
  /** SAC of the asset paid — derived from code:issuer (lib/swapAssets), never looked up by symbol. */
  tokenIn: string
  /** SAC of the asset received, derived the same way. */
  tokenOut: string
  amountIn: string // in stroops / base units as string
  slippageBps: number // e.g. 50 = 0.5%
  feePayerAddress: string
}

/**
 * The outcome of asking the router. `unavailable` (no API key, or the router
 * unreachable) is the only case in which a caller may try the classic DEX for
 * the SAME pair; `mismatch` is never retried elsewhere — the router answered
 * about a different asset, and that is not a quote for this one.
 */
export type SoroswapQuoteResult =
  | { ok: true; quote: SwapQuote }
  | { ok: false; kind: 'unavailable' | 'no-route' | 'mismatch'; reason: string }

/** Fetch a live swap quote from the Soroswap aggregator router. */
export async function getSoroswapQuote(params: SwapParams): Promise<SoroswapQuoteResult> {
  const client = getSoroswapClient()
  if (!client) {
    console.warn('[soroswap] NEXT_PUBLIC_SOROSWAP_API_KEY is missing; using SDEX fallback')
    return { ok: false, kind: 'unavailable', reason: 'Soroswap is not configured in this build.' }
  }

  let result: QuoteResponse
  try {
    result = await client.quote({
      assetIn: params.tokenIn,
      assetOut: params.tokenOut,
      amount: BigInt(params.amountIn),
      tradeType: TradeType.EXACT_IN,
      protocols: [
        SupportedProtocols.SOROSWAP,
        SupportedProtocols.PHOENIX,
        SupportedProtocols.AQUA,
        SupportedProtocols.SDEX,
      ],
      slippageBps: params.slippageBps,
    })
  } catch (err) {
    console.warn('[soroswap] getQuote failed:', err)
    return { ok: false, kind: 'unavailable', reason: 'Soroswap could not be reached.' }
  }

  if (!result?.amountOut) return { ok: false, kind: 'no-route', reason: 'Soroswap found no route for this pair.' }
  const mismatch = quoteMismatch(result, params.tokenIn, params.tokenOut)
  if (mismatch) return { ok: false, kind: 'mismatch', reason: mismatch }

  const routePlan = result.routePlan ?? []
  return {
    ok: true,
    quote: {
      amountOut: result.amountOut.toString(),
      priceImpact: Number(result.priceImpactPct || '0'),
      path: routePlan.flatMap((r) => r.swapInfo.path),
      protocols: [...new Set(routePlan.map((r) => r.swapInfo.protocol))],
      rawQuote: result,
      ttl: Date.now() + 30_000, // 30-second TTL
    },
  }
}

/**
 * Build an assembled Soroswap swap XDR, ready for signing, from the quote the
 * user reviewed — not a fresh one, which could route differently from what
 * was shown. Returns null on failure.
 */
export async function buildSoroswapSwapXdr(quote: SwapQuote, feePayerAddress: string): Promise<string | null> {
  try {
    const client = getSoroswapClient()
    if (!client) {
      return null
    }
    const build = await client.build({
      quote: quote.rawQuote,
      from: feePayerAddress,
      to: feePayerAddress,
    })
    return build.xdr
  } catch (err) {
    console.warn('[soroswap] buildSwapXdr failed:', err)
    return null
  }
}
