/**
 * Honest spread and price impact calculation for transparent trading.
 * Shows users the bid-ask spread before confirmation, not after.
 */

import { Horizon, Asset } from '@stellar/stellar-sdk';
import { getNetwork } from './network';

export interface OrderBookSpread {
  /** Best bid price (highest buy price) */
  bestBid: number;
  /** Best ask price (lowest sell price) */
  bestAsk: number;
  /** Spread as percentage: (ask - bid) / bid * 100 */
  spreadPct: number;
  /** Number of bids on the book */
  bidCount: number;
  /** Number of asks on the book */
  askCount: number;
  /** Total depth on bid side (in destination asset) */
  bidDepth: number;
  /** Total depth on ask side (in source asset) */
  askDepth: number;
}

export interface PriceImpactAnalysis {
  /** Price impact from Soroswap SDK as percentage */
  priceImpactPct: number;
  /** Bid-ask spread as percentage */
  spreadPct: number;
  /** Combined impact: price impact + spread */
  totalImpactPct: number;
  /** Whether this trade exceeds the threshold */
  exceedsThreshold: boolean;
  /** Reason for exceeding threshold if applicable */
  refusalReason?: string;
}

export interface ReverseQuoteResult {
  /** Amount user would receive if they sold immediately at current ask */
  sellbackAmount: number;
  /** Loss from round-trip (buy spread loss + sell spread loss) */
  spreadLossPct: number;
  /** Effective slippage over the round trip */
  roundTripImpactPct: number;
}

/**
 * Fetch order book spread for a trading pair from Horizon.
 * Returns bid/ask prices and depth information.
 */
export async function fetchOrderBookSpread(
  sourceAsset: Asset,
  destAsset: Asset,
): Promise<OrderBookSpread | null> {
  try {
    const server = new Horizon.Server(getNetwork().horizonUrl);
    const orderBook = await server.orderbook(sourceAsset, destAsset).call();

    const bids = orderBook.bids || [];
    const asks = orderBook.asks || [];

    if (bids.length === 0 || asks.length === 0) {
      return null; // Empty book
    }

    // Best bid is highest buy price (first in sorted list)
    const bestBid = Number(bids[0].price);
    // Best ask is lowest sell price (first in sorted list)
    const bestAsk = Number(asks[0].price);

    // Spread as percentage
    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;

    // Calculate depth
    let bidDepth = 0;
    let askDepth = 0;
    for (const bid of bids) {
      bidDepth += Number(bid.amount);
    }
    for (const ask of asks) {
      askDepth += Number(ask.amount);
    }

    return {
      bestBid,
      bestAsk,
      spreadPct,
      bidCount: bids.length,
      askCount: asks.length,
      bidDepth,
      askDepth,
    };
  } catch (err) {
    console.warn('[spreadCalculator] Failed to fetch order book:', err);
    return null;
  }
}

/**
 * Analyze total price impact: combine Soroswap price impact with bid-ask spread.
 * Price impact is from the Soroswap SDK, spread is calculated from order book.
 * Refuses orders exceeding a threshold with a clear reason.
 */
export function analyzePriceImpact(
  soroswapPriceImpactPct: number,
  bidAskSpreadPct: number | null,
  thresholdPct: number = 5.0, // Default 5% threshold
): PriceImpactAnalysis {
  const spreadPct = bidAskSpreadPct ?? 0;
  const totalImpactPct = soroswapPriceImpactPct + spreadPct;

  const exceedsThreshold = totalImpactPct > thresholdPct;
  let refusalReason: string | undefined;

  if (exceedsThreshold) {
    const impactBreakdown =
      bidAskSpreadPct !== null
        ? `${soroswapPriceImpactPct.toFixed(2)}% price impact + ${spreadPct.toFixed(2)}% spread`
        : `${soroswapPriceImpactPct.toFixed(2)}% price impact`;
    refusalReason = `Order exceeds ${thresholdPct}% total impact threshold. Combined impact: ${impactBreakdown} = ${totalImpactPct.toFixed(2)}%`;
  }

  return {
    priceImpactPct: soroswapPriceImpactPct,
    spreadPct,
    totalImpactPct,
    exceedsThreshold,
    refusalReason,
  };
}

/**
 * Calculate what user would get if they sold immediately after buying.
 * This shows them the realistic cost of the round-trip spread.
 *
 * Logic:
 * 1. User buys amountIn at bestAsk → receives amountOut
 * 2. User immediately sells amountOut at bestBid → receives sellbackAmount
 * 3. Spread loss = (sellbackAmount - amountIn) / amountIn as percentage
 *
 * When buying at ask and selling at bid on the opposite side, the user eats both spreads.
 */
export function calculateReverseQuote(
  amountIn: number,
  amountOut: number,
  bestBid: number,
  bestAsk: number,
): ReverseQuoteResult {
  // When buying at ask: price is bestAsk (we pay more)
  // When selling at bid: price is bestBid (we get less)

  // User buys amountIn of source at bestAsk
  // Gets amountOut of destination
  // Then sells amountOut of destination at bestBid
  // Gets: amountOut * bestBid of source back

  const sellbackAmount = amountOut * bestBid;
  const originalCost = amountIn;
  const roundTripLoss = originalCost - sellbackAmount;
  const spreadLossPct = (roundTripLoss / originalCost) * 100;

  // Round trip impact: both buying spread + selling spread
  const roundTripImpactPct = ((bestAsk - bestBid) / bestBid) * 2 * 100;

  return {
    sellbackAmount,
    spreadLossPct,
    roundTripImpactPct,
  };
}

/**
 * Format spread data for UI display.
 */
export function formatSpreadDisplay(spread: OrderBookSpread): {
  bid: string;
  ask: string;
  spreadPct: string;
  depth: string;
} {
  return {
    bid: spread.bestBid.toFixed(4),
    ask: spread.bestAsk.toFixed(4),
    spreadPct: spread.spreadPct.toFixed(2),
    depth: `${spread.bidDepth.toFixed(0)} / ${spread.askDepth.toFixed(0)}`,
  };
}

/**
 * Format price impact analysis for UI display.
 */
export function formatImpactDisplay(analysis: PriceImpactAnalysis): {
  totalImpactPct: string;
  breakdown: string;
  status: 'ok' | 'warning' | 'error';
} {
  const status = analysis.exceedsThreshold ? 'error' : analysis.totalImpactPct > 2 ? 'warning' : 'ok';
  const breakdown =
    analysis.spreadPct > 0
      ? `${analysis.priceImpactPct.toFixed(2)}% price impact + ${analysis.spreadPct.toFixed(2)}% spread`
      : `${analysis.priceImpactPct.toFixed(2)}% price impact`;

  return {
    totalImpactPct: analysis.totalImpactPct.toFixed(2),
    breakdown,
    status,
  };
}
