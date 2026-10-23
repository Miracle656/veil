/**
 * Enhanced Soroswap with honest spread and price impact display.
 * Calculates bid-ask spread, price impact threshold, and reverse quotes.
 */

import { Asset } from '@stellar/stellar-sdk';
import type { SwapQuote } from './soroswap';
 * Wraps a swap quote with the spread and price-impact disclosure of #732.
 *
 * The quote itself is unchanged; what this adds is the second half of the cost
 * the user pays — the bid-ask spread they cross — plus what a round trip would
 * cost them. Where that cannot be measured it says so, rather than reporting a
 * zero that reads like a measurement.
 *
 * Assets arrive as registry-checked `code:issuer` pairs and are turned into
 * classic assets with `classicAsset` (#793). This module does not resolve an
 * asset by its code: mainnet has several assets per popular code and only one
 * of each is the real one, so a symbol lookup here would be how a confident
 * price gets quoted over the wrong asset.
 */

import type { SwapQuote } from './soroswap';
import { classicAsset, type SwapAsset } from './swapAssets';
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
  /** Bid-ask spread from the order book, when there was one to read. */
  spread?: OrderBookSpread;
  /**
   * Price impact combined with the spread. Always present: when the spread
   * could not be measured it carries `spreadKnown: false` and a null total, so
   * the screen can say the figure is incomplete instead of implying zero.
   */
  impactAnalysis: PriceImpactAnalysis;
  /** What the user would receive selling the output straight back. */
  reverseQuote?: ReverseQuoteResult;
  /** Whether this order should be refused on the impact threshold. */
  shouldRefuse: boolean;
  /** Reason to refuse, if it is refused. */
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
 * Add spread and impact disclosure to a quote.
 *
 * `amountIn` is in whole units of the source asset, matching what the user
 * typed, and `quote.amountOut` is in stroops.
 */
export async function enhanceQuoteWithSpread(
  quote: SwapQuote,
  from: SwapAsset,
  to: SwapAsset,
  amountIn: number,
  thresholdPct: number = 5.0,
): Promise<HonestSwapQuote> {
  const priceImpactPct = quote.priceImpact * 100;

  const lookup = await fetchOrderBookSpread(classicAsset(from), classicAsset(to));
  const spread = lookup.status === 'measured' ? lookup.spread : undefined;

  // A spread we could not measure goes in as null, not 0.
  const impactAnalysis = analyzePriceImpact(
    priceImpactPct,
    spread ? spread.spreadPct : null,
    thresholdPct,
  );

  // Horizon's own reason is more specific than the generic one, so prefer it.
  if (lookup.status === 'unavailable' && impactAnalysis.disclosure) {
    impactAnalysis.disclosure = lookup.reason;
  }

  const enhanced: HonestSwapQuote = {
    ...quote,
    spread,
    impactAnalysis,
    shouldRefuse: impactAnalysis.exceedsThreshold,
    refusalReason: impactAnalysis.refusalReason,
  };

  if (spread) {
    const amountOut = Number(quote.amountOut) / 1e7;
    enhanced.reverseQuote = calculateReverseQuote(
      amountIn,
      amountOut,
      spread.bestBid,
      spread.bestAsk,
    );
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
 * The least the user will accept, given their slippage tolerance.
 *
 * Price impact and spread are already inside `amountOut` — the quote is what
 * the route actually pays out — so slippage is all that is applied on top.
 */
export function calculateMinReceived(amountOut: number, slippageBps: number): number {
  return amountOut * (1 - slippageBps / 10_000);
}

/**
 * Format a quote for display. Every field is either a real figure or null;
 * nothing here substitutes a zero for a measurement that was not taken.
 */
export function formatHonestQuote(
  quote: HonestSwapQuote,
  amountIn: number,
  tokenIn: string,
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
  disclosure: string | null;
  warning: string | null;
} {
  const out = Number(quote.amountOut) / 1e7;
  const amountOut = out.toFixed(7).replace(/\.?0+$/, '');

  // The rate is dest per source. Without a positive amountIn there is no rate
  // to quote, so say so rather than printing a placeholder that looks real.
  const rate = amountIn > 0 && Number.isFinite(out) ? (out / amountIn).toFixed(4) : '—';

  const spread = quote.spread
    ? `${quote.spread.spreadPct.toFixed(2)}% ` +
      `(Bid ${quote.spread.bestBid.toFixed(4)} / Ask ${quote.spread.bestAsk.toFixed(4)})`
    : null;

  const a = quote.impactAnalysis;
  const impact = a.spreadKnown
    ? `${(a.totalImpactPct ?? 0).toFixed(2)}% total ` +
      `(${a.priceImpactPct.toFixed(2)}% price impact + ${(a.spreadPct ?? 0).toFixed(2)}% spread)`
    : `${a.priceImpactPct.toFixed(2)}% price impact (spread not measured)`;

  const sellback = quote.reverseQuote
    ? `If sold immediately: ${quote.reverseQuote.sellbackAmount.toFixed(7)} ${tokenIn} ` +
      `(${quote.reverseQuote.spreadLossPct.toFixed(2)}% loss)`
    : null;

  return {
    amountOut,
    rate,
    spread,
    impact,
    sellback,
    disclosure: a.disclosure ?? null,
    warning: quote.shouldRefuse ? (quote.refusalReason ?? null) : null,
  };
}
