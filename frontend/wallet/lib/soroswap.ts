import { Networks } from '@stellar/stellar-sdk'
import { getNetwork } from '@/lib/network'
import {
  SoroswapSDK,
  SupportedNetworks,
  SupportedProtocols,
  TradeType,
} from '@soroswap/sdk'

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
  rawQuote: unknown
  ttl: number // unix timestamp when the quote expires
}

export interface SwapParams {
  tokenIn: string
  tokenOut: string
  amountIn: string // in stroops / base units as string
  slippageBps: number // e.g. 50 = 0.5%
  feePayerAddress: string
}

/**
 * Fetch a live swap quote from the Soroswap aggregator router.
 * Returns null when the SDK is unavailable or the pair has no liquidity.
 */
export async function getSoroswapQuote(params: SwapParams): Promise<SwapQuote | null> {
  try {
    const client = getSoroswapClient()
    if (!client) {
      console.warn('[soroswap] NEXT_PUBLIC_SOROSWAP_API_KEY is missing; using SDEX fallback')
      return null
    }

    const result = await client.quote({
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

    if (!result?.amountOut) return null
    const routePlan = result.routePlan ?? []
    return {
      amountOut: result.amountOut.toString(),
      priceImpact: Number(result.priceImpactPct || '0'),
      path: routePlan.flatMap((r) => r.swapInfo.path),
      protocols: [...new Set(routePlan.map((r) => r.swapInfo.protocol))],
      rawQuote: result,
      ttl: Date.now() + 30_000, // 30-second TTL
    }
  } catch (err) {
    console.warn('[soroswap] getQuote failed:', err)
    return null
  }
}

/**
 * Build an assembled Soroswap swap XDR ready for passkey signing.
 * Returns null on failure (caller should fall back to classic SDEX).
 */
export async function buildSoroswapSwapXdr(params: SwapParams): Promise<string | null> {
  try {
    const client = getSoroswapClient()
    if (!client) {
      return null
    }

    const quote = await client.quote({
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

    const build = await client.build({
      quote,
      from: params.feePayerAddress,
      to: params.feePayerAddress,
    })

    return build.xdr
  } catch (err) {
    console.warn('[soroswap] buildSwapXdr failed:', err)
    return null
  }
}

/** Fetch the Soroswap token list and return the contract address for a symbol. */
export async function resolveTokenAddress(symbol: string): Promise<string | null> {
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json'
    )
    const list = await res.json()
    const tokens: Array<{ symbol: string; contract: string; network: string }> = list.tokens ?? []
    const network = IS_TESTNET ? 'TESTNET' : 'MAINNET'
    const found = tokens.find(
      (t) => t.symbol.toUpperCase() === symbol.toUpperCase() && t.network === network
    )
    return found?.contract ?? null
  } catch {
    return null
  }
}
