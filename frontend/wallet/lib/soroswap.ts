/**
 * soroswap.ts
 * Wrapper around @soroswap/sdk for quote fetching and swap transaction building.
 * Used by the swap page (issue #119).
 */

import { Networks } from '@stellar/stellar-sdk'
import { getNetwork } from '@/lib/network'

const net = getNetwork()
const IS_TESTNET = net.networkPassphrase === Networks.TESTNET

// Soroswap Router contract address (testnet)
export const SOROSWAP_ROUTER_TESTNET = 'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2'

export interface SwapQuote {
  amountOut: string
  priceImpact: number
  path: string[]
  protocols: string[]
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
    // Dynamic import so the page still loads even if the package isn't installed yet
    const { SoroswapRouter } = await import('@soroswap/sdk')
    const router = new SoroswapRouter({
      network: IS_TESTNET ? 'TESTNET' : 'MAINNET',
    })
    const result = await router.getExpectedAmount({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amount: BigInt(params.amountIn),
      slippage: params.slippageBps / 10000,
    })
    if (!result || !result.amountOut) return null
    return {
      amountOut: result.amountOut.toString(),
      priceImpact: result.priceImpact ?? 0,
      path: result.path ?? [],
      protocols: result.protocols ?? ['Soroswap'],
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
    const { SoroswapRouter } = await import('@soroswap/sdk')
    const router = new SoroswapRouter({
      network: IS_TESTNET ? 'TESTNET' : 'MAINNET',
    })
    const tx = await router.buildSwapTransaction({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amount: BigInt(params.amountIn),
      slippage: params.slippageBps / 10000,
      feePayerAddress: params.feePayerAddress,
      networkPassphrase: net.networkPassphrase,
    })
    return tx.toXDR()
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
