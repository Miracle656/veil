/**
 * Spread and price-impact disclosure (#732).
 *
 * The behaviour worth pinning down here is not that the arithmetic runs — it is
 * that a figure nobody measured is reported as unknown rather than as zero, and
 * that the order book is read in the direction the rest of the maths assumes.
 */

import { Asset, Horizon } from '@stellar/stellar-sdk';

// `Horizon` on the real SDK is a non-configurable namespace, so it cannot be
// spied on; swap in a plain object carrying a mockable `Server`.
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return { ...actual, Horizon: { ...actual.Horizon, Server: jest.fn() } };
});

import {
  analyzePriceImpact,
  calculateReverseQuote,
  fetchOrderBookSpread,
  formatImpactDisplay,
  formatSpreadDisplay,
} from '../spreadCalculator';

jest.mock('../network', () => ({
  getNetwork: () => ({ name: 'mainnet', horizonUrl: 'https://horizon.example/' }),
}));

const USDC = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');
const USDY = new Asset('USDY', 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6');

/** Point `new Horizon.Server()` at a stub order book, returning the spy. */
function mockOrderbook(result: unknown, { reject = false } = {}) {
  const call = reject
    ? jest.fn().mockRejectedValue(new Error('Network error'))
    : jest.fn().mockResolvedValue(result);
  const orderbook = jest.fn(() => ({ call }));
  (Horizon.Server as unknown as jest.Mock).mockImplementation(() => ({ orderbook }));
  return orderbook;
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('fetchOrderBookSpread', () => {
  // The thin USDC/USDY book from #732: bid 1.0820, ask 1.1445 USDC per USDY.
  const thinBook = {
    bids: [
      { price: '1.0820', amount: '500' },
      { price: '1.0700', amount: '300' },
    ],
    asks: [
      { price: '1.1445', amount: '200' },
      { price: '1.1500', amount: '400' },
    ],
  };

  it('reads the book as source per dest, not the other way round', async () => {
    const orderbook = mockOrderbook(thinBook);

    await fetchOrderBookSpread(USDC, USDY);

    // Prices must come back as USDC (what you pay) per USDY (what you get), so
    // the counter asset is the source and the base is the dest — the reverse of
    // the way the swap flows. Calling it source-first silently inverts every
    // figure on the confirmation screen.
    expect(orderbook).toHaveBeenCalledWith(USDY, USDC);
  });

  it('reports a two-sided book as measured', async () => {
    mockOrderbook(thinBook);

    const result = await fetchOrderBookSpread(USDC, USDY);

    expect(result.status).toBe('measured');
    if (result.status !== 'measured') throw new Error('expected a measured spread');
    expect(result.spread.bestBid).toBe(1.082);
    expect(result.spread.bestAsk).toBe(1.1445);
    expect(result.spread.bidCount).toBe(2);
    expect(result.spread.askCount).toBe(2);
    expect(result.spread.bidDepth).toBe(800); // 500 + 300
    expect(result.spread.askDepth).toBe(600); // 200 + 400
    // (1.1445 - 1.082) / 1.082 * 100
    expect(result.spread.spreadPct).toBeCloseTo(5.79, 1);
  });

  it('reports an empty book as no-book, which is not a zero spread', async () => {
    mockOrderbook({ bids: [], asks: [] });

    const result = await fetchOrderBookSpread(USDC, USDY);

    expect(result.status).toBe('no-book');
  });

  it('reports a one-sided book as no-book', async () => {
    mockOrderbook({ bids: [{ price: '1.08', amount: '500' }], asks: [] });

    const result = await fetchOrderBookSpread(USDC, USDY);

    expect(result.status).toBe('no-book');
  });

  it('reports a failed lookup as unavailable, distinct from no-book', async () => {
    mockOrderbook(null, { reject: true });

    const result = await fetchOrderBookSpread(USDC, USDY);

    // A Horizon failure is not a measurement. Collapsing it into "no spread"
    // is how a missing number becomes a confident 0.00% downstream.
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toMatch(/unknown/i);
    // And the reason must not carry the Horizon URL, which holds provider keys.
    expect(result.reason).not.toMatch(/horizon\.example/);
  });

  it('reports a nonsense top of book as unavailable', async () => {
    mockOrderbook({
      bids: [{ price: '0', amount: '1' }],
      asks: [{ price: 'nope', amount: '1' }],
    });

    const result = await fetchOrderBookSpread(USDC, USDY);

    expect(result.status).toBe('unavailable');
  });
});

describe('analyzePriceImpact', () => {
  it('adds the spread to the price impact when both are known', () => {
    const analysis = analyzePriceImpact(0.5, 2.0, 5.0);

    expect(analysis.priceImpactPct).toBe(0.5);
    expect(analysis.spreadPct).toBe(2.0);
    expect(analysis.totalImpactPct).toBe(2.5);
    expect(analysis.spreadKnown).toBe(true);
    expect(analysis.exceedsThreshold).toBe(false);
    expect(analysis.refusalReason).toBeUndefined();
    expect(analysis.disclosure).toBeUndefined();
  });

  it('refuses an order over the threshold and says why', () => {
    const analysis = analyzePriceImpact(2.0, 4.5, 5.0);

    expect(analysis.totalImpactPct).toBe(6.5);
    expect(analysis.exceedsThreshold).toBe(true);
    expect(analysis.refusalReason).toContain('6.50%');
    expect(analysis.refusalReason).toContain('4.50% spread');
  });

  it('refuses the thin #732 book: small impact, large spread', () => {
    const analysis = analyzePriceImpact(0.05, 5.79, 5.0);

    expect(analysis.totalImpactPct).toBeCloseTo(5.84, 1);
    expect(analysis.exceedsThreshold).toBe(true);
  });

  // The core of #732: an unmeasured spread must never read as zero.
  it('reports an unmeasured spread as unknown and withholds the total', () => {
    const analysis = analyzePriceImpact(2.5, null, 5.0);

    expect(analysis.priceImpactPct).toBe(2.5);
    expect(analysis.spreadPct).toBeNull();
    expect(analysis.totalImpactPct).toBeNull();
    expect(analysis.spreadKnown).toBe(false);
    // Still judged on what we do know, so a bad trade is still stopped...
    expect(analysis.exceedsThreshold).toBe(false);
    // ...but the user is told a term is missing rather than shown a total.
    expect(analysis.disclosure).toMatch(/could not be measured/i);
  });

  it('still refuses on price impact alone when the spread is unknown', () => {
    const analysis = analyzePriceImpact(7.5, null, 5.0);

    expect(analysis.exceedsThreshold).toBe(true);
    expect(analysis.totalImpactPct).toBeNull();
    expect(analysis.refusalReason).toContain('7.50% price impact');
    // No invented spread term in the breakdown.
    expect(analysis.refusalReason).not.toContain('spread');
  });

  it('distinguishes a genuinely zero spread from an unknown one', () => {
    const zero = analyzePriceImpact(0.5, 0, 5.0);

    expect(zero.spreadPct).toBe(0);
    expect(zero.totalImpactPct).toBe(0.5);
    expect(zero.spreadKnown).toBe(true);
    expect(zero.disclosure).toBeUndefined();
  });

  it('honours a custom threshold', () => {
    expect(analyzePriceImpact(1.0, 1.0, 1.5).exceedsThreshold).toBe(true);
    expect(analyzePriceImpact(1.0, 1.0, 10).exceedsThreshold).toBe(false);
  });

  it('treats a total exactly at the threshold as allowed', () => {
    const analysis = analyzePriceImpact(2.0, 3.0, 5.0);

    expect(analysis.totalImpactPct).toBe(5.0);
    expect(analysis.exceedsThreshold).toBe(false);
  });
});

describe('calculateReverseQuote', () => {
  it('prices the sell-back against the bid, in the source asset', () => {
    // 1000 USDC buys 873.47 USDY at the 1.1445 ask; selling that straight back
    // at the 1.082 bid returns 873.47 * 1.082 = 945.09 USDC.
    const result = calculateReverseQuote(1000, 873.47, 1.082, 1.1445);

    expect(result.sellbackAmount).toBeCloseTo(945.09, 1);
    expect(result.spreadLossPct).toBeCloseTo(5.49, 1);
  });

  it('counts the spread once over a round trip, not twice', () => {
    // Lifting the ask and then hitting the bid crosses the spread a single
    // time: (1.1445 - 1.082) / 1.1445 ≈ 5.46%. Doubling it to 11.58% put a
    // figure on screen that was twice the real cost.
    const result = calculateReverseQuote(1000, 873.47, 1.082, 1.1445);

    expect(result.roundTripImpactPct).toBeCloseTo(5.46, 1);
    // And it agrees with the loss actually realised on the round trip.
    expect(result.roundTripImpactPct).toBeCloseTo(result.spreadLossPct, 0);
  });

  it('shows no loss when bid and ask are equal', () => {
    const result = calculateReverseQuote(1000, 1000, 1.0, 1.0);

    expect(result.sellbackAmount).toBe(1000);
    expect(result.spreadLossPct).toBe(0);
    expect(result.roundTripImpactPct).toBe(0);
  });

  it('scales with the trade size', () => {
    const small = calculateReverseQuote(0.001, 0.00087347, 1.082, 1.1445);
    const large = calculateReverseQuote(1_000_000, 873_470, 1.082, 1.1445);

    expect(small.spreadLossPct).toBeCloseTo(5.49, 1);
    expect(large.spreadLossPct).toBeCloseTo(5.49, 1);
  });

  it('does not divide by zero on a zero input', () => {
    const result = calculateReverseQuote(0, 0, 1.082, 1.1445);

    expect(result.spreadLossPct).toBe(0);
    expect(Number.isFinite(result.roundTripImpactPct)).toBe(true);
  });
});

describe('formatSpreadDisplay', () => {
  it('formats bid, ask, spread and depth', () => {
    const out = formatSpreadDisplay({
      bestBid: 1.082,
      bestAsk: 1.1445,
      spreadPct: 5.7764,
      bidCount: 2,
      askCount: 2,
      bidDepth: 800,
      askDepth: 600,
    });

    expect(out.bid).toBe('1.0820');
    expect(out.ask).toBe('1.1445');
    expect(out.spreadPct).toBe('5.78');
    expect(out.depth).toBe('800 / 600');
  });
});

describe('formatImpactDisplay', () => {
  it('grades a small measured total as ok', () => {
    const out = formatImpactDisplay(analyzePriceImpact(0.3, 0.2, 5.0));

    expect(out.status).toBe('ok');
    expect(out.totalImpactPct).toBe('0.50');
  });

  it('grades a large measured total as a warning', () => {
    const out = formatImpactDisplay(analyzePriceImpact(2.0, 1.0, 5.0));

    expect(out.status).toBe('warning');
  });

  it('grades an over-threshold total as an error', () => {
    const out = formatImpactDisplay(analyzePriceImpact(2.0, 4.5, 5.0));

    expect(out.status).toBe('error');
  });

  it('grades an unmeasured spread as unknown with no total', () => {
    const out = formatImpactDisplay(analyzePriceImpact(0.3, null, 5.0));

    // Not 'ok': the screen must not present an unmeasured cost as cleared.
    expect(out.status).toBe('unknown');
    expect(out.totalImpactPct).toBeNull();
    expect(out.breakdown).toMatch(/spread not measured/);
  });
});
