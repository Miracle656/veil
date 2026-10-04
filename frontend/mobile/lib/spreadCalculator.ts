/**
 * Honest spread and price-impact disclosure for swaps (#732).
 *
 * The point of this module is that the user sees the real cost of a trade
 * *before* confirming it, so the one rule it holds to is: a number we could not
 * measure is reported as unknown, never as zero. A missing order book used to
 * read as "0.00% spread", which shows a confident figure where there is no
 * measurement — the exact failure #732 exists to prevent.
 *
 * ## Price convention
 *
 * Everything here is quoted as **source per dest**: "how much of what you pay
 * buys one of what you receive". For a USDC → USDY swap that is USDC per USDY.
 *
 * Horizon's order book is keyed base/counter and prices are counter-per-base,
 * so to get source-per-dest we ask for base = dest, counter = source — i.e.
 * `orderbook(selling: dest, buying: source)`, which is the reverse of the way
 * the swap itself flows. Under that convention:
 *
 *   - a swap source → dest **buys** the base, so it lifts the `asks`, paying
 *     `bestAsk` source per dest;
 *   - selling the dest straight back **hits** the `bids`, receiving `bestBid`
 *     source per dest.
 *
 * Getting this backwards inverts every figure on the confirmation screen, so
 * the direction is asserted in lib/__tests__/spreadCalculator.test.ts.
 */

import { Horizon, Asset } from '@stellar/stellar-sdk';
import { getNetwork } from './network';

export interface OrderBookSpread {
  /** Best bid: the most source per dest anyone will pay for the dest asset. */
  bestBid: number;
  /** Best ask: the least source per dest anyone will sell the dest asset for. */
  bestAsk: number;
  /** Spread as a percentage of the bid: (ask - bid) / bid * 100 */
  spreadPct: number;
  /** Number of bids on the book */
  bidCount: number;
  /** Number of asks on the book */
  askCount: number;
  /** Summed `amount` across the bid side, as Horizon reports it. */
  bidDepth: number;
  /** Summed `amount` across the ask side, as Horizon reports it. */
  askDepth: number;
}

/**
 * Why there is no spread to show, kept distinct from "the spread is zero".
 *
 * - `measured` — we have a two-sided book.
 * - `no-book`  — the pair has no order book, or only one side of one. Normal
 *                for a pair that only routes through an AMM.
 * - `unavailable` — we could not ask. A Horizon failure is not a measurement
 *                and must not be rendered as one.
 */
export type SpreadLookup =
  | { status: 'measured'; spread: OrderBookSpread }
  | { status: 'no-book' }
  | { status: 'unavailable'; reason: string };

export interface PriceImpactAnalysis {
  /** Price impact from the swap quote, as a percentage. */
  priceImpactPct: number;
  /** Bid-ask spread as a percentage, or null when it could not be measured. */
  spreadPct: number | null;
  /** Price impact + spread, or null when the spread is unknown. */
  totalImpactPct: number | null;
  /** False when {@link spreadPct} is null, so the UI can say so explicitly. */
  spreadKnown: boolean;
  /** Whether the trade exceeds the threshold on what we could actually measure. */
  exceedsThreshold: boolean;
  /** Reason for exceeding the threshold, if it does. */
  refusalReason?: string;
  /** What the user is not being told, when something could not be measured. */
  disclosure?: string;
}

export interface ReverseQuoteResult {
  /** Source asset returned by selling the whole output straight back. */
  sellbackAmount: number;
  /** Round-trip loss as a percentage of what was paid in. */
  spreadLossPct: number;
  /** The spread crossed by a round trip, as a percentage of the ask. */
  roundTripImpactPct: number;
}

/**
 * Fetch the order-book spread for a pair.
 *
 * `sourceAsset` is what the user pays, `destAsset` what they receive; see the
 * price convention at the top of this file for why the Horizon call is the
 * other way round.
 */
export async function fetchOrderBookSpread(
  sourceAsset: Asset,
  destAsset: Asset,
): Promise<SpreadLookup> {
  let orderBook: Horizon.ServerApi.OrderbookRecord;
  try {
    const server = new Horizon.Server(getNetwork().horizonUrl);
    // base = dest, counter = source, so prices come back as source per dest.
    orderBook = await server.orderbook(destAsset, sourceAsset).call();
  } catch {
    // Deliberately not folded into "no spread": not knowing the spread is a
    // different thing from knowing it is zero. The error object is not logged —
    // it carries the Horizon URL.
    return {
      status: 'unavailable',
      reason: 'The order book could not be read, so the spread is unknown.',
    };
  }

  const bids = orderBook.bids ?? [];
  const asks = orderBook.asks ?? [];

  // A one-sided book has no spread to quote.
  if (bids.length === 0 || asks.length === 0) return { status: 'no-book' };

  // Horizon sorts bids best-first (highest) and asks best-first (lowest).
  const bestBid = Number(bids[0].price);
  const bestAsk = Number(asks[0].price);

  // A non-finite or non-positive top of book is not a price.
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
    return {
      status: 'unavailable',
      reason: 'The top of the order book was not a usable price, so the spread is unknown.',
    };
  }

  let bidDepth = 0;
  let askDepth = 0;
  for (const bid of bids) bidDepth += Number(bid.amount);
  for (const ask of asks) askDepth += Number(ask.amount);

  return {
    status: 'measured',
    spread: {
      bestBid,
      bestAsk,
      spreadPct: ((bestAsk - bestBid) / bestBid) * 100,
      bidCount: bids.length,
      askCount: asks.length,
      bidDepth,
      askDepth,
    },
  };
}

/**
 * Combine the quote's own price impact with the bid-ask spread.
 *
 * Pass `null` for `bidAskSpreadPct` when the spread could not be measured. It is
 * then reported as unknown and the total is withheld rather than quietly
 * computed as if the spread were zero. The threshold is still applied to the
 * price impact alone, so a bad trade is still refused — but the screen has to
 * say that one term is missing.
 */
export function analyzePriceImpact(
  soroswapPriceImpactPct: number,
  bidAskSpreadPct: number | null,
  thresholdPct: number = 5.0,
): PriceImpactAnalysis {
  const spreadKnown = bidAskSpreadPct !== null;
  const totalImpactPct = spreadKnown ? soroswapPriceImpactPct + bidAskSpreadPct : null;

  // Judge on what we measured. With the spread unknown the real total can only
  // be higher, so clearing the threshold here is not a clean bill of health —
  // hence the disclosure.
  const judged = totalImpactPct ?? soroswapPriceImpactPct;
  const exceedsThreshold = judged > thresholdPct;

  let refusalReason: string | undefined;
  if (exceedsThreshold) {
    const breakdown = spreadKnown
      ? `${soroswapPriceImpactPct.toFixed(2)}% price impact + ${bidAskSpreadPct.toFixed(2)}% spread`
      : `${soroswapPriceImpactPct.toFixed(2)}% price impact`;
    refusalReason =
      `Order exceeds ${thresholdPct}% total impact threshold. ` +
      `Combined impact: ${breakdown} = ${judged.toFixed(2)}%`;
  }

  return {
    priceImpactPct: soroswapPriceImpactPct,
    spreadPct: bidAskSpreadPct,
    totalImpactPct,
    spreadKnown,
    exceedsThreshold,
    refusalReason,
    disclosure: spreadKnown
      ? undefined
      : 'The bid-ask spread could not be measured for this pair, so the total ' +
        'cost is not shown. The real cost may be higher than the price impact.',
  };
}

/**
 * What the user would get back by selling the whole output straight again.
 *
 * Buying lifts the ask and selling back hits the bid, so the round trip crosses
 * the spread **once**, not twice. `roundTripImpactPct` is that one crossing,
 * `(ask - bid) / ask`, which is what the user actually loses; counting it twice
 * doubles the figure on the confirmation screen.
 *
 * Prices are source per dest; see the convention at the top of this file.
 */
export function calculateReverseQuote(
  amountIn: number,
  amountOut: number,
  bestBid: number,
  bestAsk: number,
): ReverseQuoteResult {
  // Sell the dest back into the bids: amountOut dest x bestBid source per dest.
  const sellbackAmount = amountOut * bestBid;
  const spreadLossPct = amountIn > 0 ? ((amountIn - sellbackAmount) / amountIn) * 100 : 0;
  const roundTripImpactPct = bestAsk > 0 ? ((bestAsk - bestBid) / bestAsk) * 100 : 0;

  return { sellbackAmount, spreadLossPct, roundTripImpactPct };
}

/**
 * Format spread data for display. Depth is the summed `amount` on each side as
 * Horizon reports it, which is why it is shown as a bare pair and not labelled
 * with an asset.
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
 * Format a price-impact analysis for display.
 *
 * An unmeasured spread gets `status: 'unknown'` and no total — it must not read
 * as a green, confident figure.
 */
export function formatImpactDisplay(analysis: PriceImpactAnalysis): {
  totalImpactPct: string | null;
  breakdown: string;
  status: 'ok' | 'warning' | 'error' | 'unknown';
} {
  const breakdown = analysis.spreadKnown
    ? `${analysis.priceImpactPct.toFixed(2)}% price impact + ` +
      `${(analysis.spreadPct ?? 0).toFixed(2)}% spread`
    : `${analysis.priceImpactPct.toFixed(2)}% price impact, spread not measured`;

  if (analysis.exceedsThreshold) {
    return {
      totalImpactPct: analysis.totalImpactPct?.toFixed(2) ?? null,
      breakdown,
      status: 'error',
    };
  }

  if (!analysis.spreadKnown) {
    return { totalImpactPct: null, breakdown, status: 'unknown' };
  }

  const total = analysis.totalImpactPct ?? analysis.priceImpactPct;
  return {
    totalImpactPct: total.toFixed(2),
    breakdown,
    status: total > 2 ? 'warning' : 'ok',
  };
}
