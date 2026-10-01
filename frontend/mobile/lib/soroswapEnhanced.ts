/**
 * Enhanced Soroswap with honest spread and price impact display.
 * Calculates bid-ask spread, price impact threshold, and reverse quotes.
 */

import { Asset } from '@stellar/stellar-sdk';
import type { SwapQuote } from './soroswap';
import {
  fetchOrderBookSpread,
  analyzePriceImpact,
  calculateReverseQuote,
  type OrderBookSpread,
  type PriceImpactAnalysis,
  type ReverseQuoteResult,
} from './spreadCalculator';

export interface HonestSwapQuote extends SwapQuote {
  /** Bid-ask spread from order book if available */
  spread?: OrderBookSpread;
  /** Price impact analysis combining Soroswap impact + spread */
  impactAnalysis?: PriceImpactAnalysis;
  /** What user would receive selling immediately after buy */
  reverseQuote?: ReverseQuoteResult;
  /** Whether this order should be refused due to impact threshold */
  shouldRefuse?: boolean;
  /** Reason to refuse if applicable */
  refusalReason?: string;
}

/**
 * Enhance a regular swap quote with spread and impact data.
 * Fetches order book, calculates spread, analyzes impact, and computes reverse quote.
 */
export async function enhanceQuoteWithSpread(
  quote: SwapQuote,
  sourceToken: string,
  destToken: string,
  amountIn: number,
  thresholdPct: number = 5.0,
): Promise<HonestSwapQuote> {
  const enhanced: HonestSwapQuote = { ...quote };

  try {
    // Resolve classic Stellar assets from tokens
    // On mainnet, these come from Soroswap's token list
    const sourceAsset = sourceToken.toUpperCase() === 'XLM'
      ? Asset.native()
      : null; // SAC tokens don't work with Horizon orderbook
    const destAsset = destToken.toUpperCase() === 'XLM'
      ? Asset.native()
      : null; // SAC tokens don't work with Horizon orderbook

    // Only fetch spread if both are classic assets (with order books)
    // SAC (Soroban-native) tokens don't have Horizon order books
    if (sourceAsset && destAsset) {
      const spread = await fetchOrderBookSpread(sourceAsset, destAsset);
      if (spread) {
        enhanced.spread = spread;

        // Analyze combined impact
        const impactAnalysis = analyzePriceImpact(
          quote.priceImpact * 100, // Convert to percentage
          spread.spreadPct,
          thresholdPct,
        );
        enhanced.impactAnalysis = impactAnalysis;

        // Check if we should refuse this order
        if (impactAnalysis.exceedsThreshold) {
          enhanced.shouldRefuse = true;
          enhanced.refusalReason = impactAnalysis.refusalReason;
        }

        // Calculate reverse quote for transparency
        if (spread.bestBid && spread.bestAsk) {
          const amountOut = Number(quote.amountOut) / 1e7;
          const reverseQuote = calculateReverseQuote(amountIn, amountOut, spread.bestBid, spread.bestAsk);
          enhanced.reverseQuote = reverseQuote;
        }
      }
    }
  } catch (err) {
    console.warn('[soroswapEnhanced] Failed to enhance quote with spread:', err);
    // Continue with base quote if enhancement fails
  }

  return enhanced;
}

/**
 * Calculate expected slippage and minimum received amount given impact.
 * Used to ensure slippage settings align with impact threshold.
 */
export function calculateMinReceived(
  amountOut: number,
  priceImpactPct: number,
  spreadPct: number,
  slippageBps: number,
): number {
  // Impact already accounted for in amountOut from the quote
  // Apply slippage on top
  const totalSlippageRatio = 1 - slippageBps / 10_000;
  return amountOut * totalSlippageRatio;
}

/**
 * Format quote data for display with spread and impact information.
 */
export function formatHonestQuote(
  quote: HonestSwapQuote,
  tokenIn: string,
  tokenOut: string,
): {
  amountOut: string;
  rate: string;
  spread: string | null;
  impact: string | null;
  sellback: string | null;
  warning: string | null;
} {
  const amountOut = (Number(quote.amountOut) / 1e7).toFixed(7).replace(/\.?0+$/, '');
  const rate =
    quote.amountOut && quote.ttl
      ? ((Number(quote.amountOut) / 1e7) / (Number(quote.amountOut) / 1e7)).toFixed(4)
      : '—';

  let spread: string | null = null;
  if (quote.spread) {
    spread = `${quote.spread.spreadPct.toFixed(2)}% (Bid ${quote.spread.bestBid.toFixed(4)} / Ask ${quote.spread.bestAsk.toFixed(4)})`;
  }

  let impact: string | null = null;
  if (quote.impactAnalysis) {
    const breakdown =
      quote.spread && quote.spread.spreadPct > 0
        ? `${quote.impactAnalysis.priceImpactPct.toFixed(2)}% price impact + ${quote.spread.spreadPct.toFixed(2)}% spread`
        : `${quote.impactAnalysis.priceImpactPct.toFixed(2)}% price impact`;
    impact = `${quote.impactAnalysis.totalImpactPct.toFixed(2)}% total (${breakdown})`;
  }

  let sellback: string | null = null;
  if (quote.reverseQuote) {
    sellback = `If sold immediately: ${quote.reverseQuote.sellbackAmount.toFixed(7)} ${tokenIn} (${quote.reverseQuote.spreadLossPct.toFixed(2)}% loss)`;
  }

  let warning: string | null = null;
  if (quote.shouldRefuse && quote.refusalReason) {
    warning = quote.refusalReason;
  }

  return { amountOut, rate, spread, impact, sellback, warning };
}
