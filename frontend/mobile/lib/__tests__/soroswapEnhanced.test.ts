/**
 * Quote enhancement with spread and price-impact disclosure (#732).
 *
 * The contract being tested: `impactAnalysis` is always present, and when the
 * spread could not be measured it says so instead of reporting zero. The
 * previous version only attached any of this when BOTH sides were XLM, so for
 * every real pair the confirmation screen fell back to 0.00% — and the refusal
 * threshold never fired at all.
 */

import {
  calculateMinReceived,
  enhanceQuoteWithSpread,
  formatHonestQuote,
  type HonestSwapQuote,
} from '../soroswapEnhanced';
import * as spreadCalculator from '../spreadCalculator';
import type { SwapQuote } from '../soroswap';
import type { SwapAsset } from '../swapAssets';

jest.mock('../spreadCalculator');

const USDC: SwapAsset = {
  code: 'USDC',
  issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
};
const USDY: SwapAsset = {
  code: 'USDY',
  issuer: 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6',
};

const baseQuote: SwapQuote = {
  amountOut: '8224500000', // 822.45, 7 decimals
  priceImpact: 0.005, // 0.5%
  path: ['native'],
  protocols: ['SOROSWAP'],
  rawQuote: null,
  ttl: Date.now() + 30_000,
};

const thinSpread = {
  bestBid: 1.082,
  bestAsk: 1.1445,
  spreadPct: 5.79,
  bidCount: 2,
  askCount: 2,
  bidDepth: 800,
  askDepth: 600,
};

const mocked = spreadCalculator as jest.Mocked<typeof spreadCalculator>;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: let the real analyzer run so the honesty rules are exercised
  // end to end rather than stubbed over.
  mocked.analyzePriceImpact.mockImplementation(
    jest.requireActual<typeof spreadCalculator>('../spreadCalculator').analyzePriceImpact,
  );
  mocked.calculateReverseQuote.mockImplementation(
    jest.requireActual<typeof spreadCalculator>('../spreadCalculator').calculateReverseQuote,
  );
});

describe('enhanceQuoteWithSpread', () => {
  it('attaches the spread for a real issued pair, not only for XLM', async () => {
    mocked.fetchOrderBookSpread.mockResolvedValue({ status: 'measured', spread: thinSpread });

    const enhanced = await enhanceQuoteWithSpread(baseQuote, USDC, USDY, 1000, 5.0);

    // The whole point of #732 is a USDC/USDY trade, so the lookup has to run
    // for issued assets. It is also addressed by code:issuer, never by symbol.
    expect(mocked.fetchOrderBookSpread).toHaveBeenCalledTimes(1);
    const [from, to] = mocked.fetchOrderBookSpread.mock.calls[0];
    expect(from.getCode()).toBe('USDC');
    expect(from.getIssuer()).toBe(USDC.issuer);
    expect(to.getCode()).toBe('USDY');
    expect(to.getIssuer()).toBe(USDY.issuer);

    expect(enhanced.spread).toEqual(thinSpread);
    expect(enhanced.impactAnalysis.spreadKnown).toBe(true);
    // 0.5% price impact + 5.79% spread
    expect(enhanced.impactAnalysis.totalImpactPct).toBeCloseTo(6.29, 2);
  });

  it('refuses a trade whose measured total clears the threshold', async () => {
    mocked.fetchOrderBookSpread.mockResolvedValue({ status: 'measured', spread: thinSpread });

    const enhanced = await enhanceQuoteWithSpread(baseQuote, USDC, USDY, 1000, 5.0);

    expect(enhanced.shouldRefuse).toBe(true);
    expect(enhanced.refusalReason).toContain('6.29%');
  });

  it('allows a trade on a tight book', async () => {
    mocked.fetchOrderBookSpread.mockResolvedValue({
      status: 'measured',
      spread: { ...thinSpread, bestBid: 1.0, bestAsk: 1.001, spreadPct: 0.1 },
    });

    const enhanced = await enhanceQuoteWithSpread(baseQuote, USDC, USDY, 1000, 5.0);

    expect(enhanced.shouldRefuse).toBe(false);
    expect(enhanced.refusalReason).toBeUndefined();
    expect(enhanced.impactAnalysis.totalImpactPct).toBeCloseTo(0.6, 2);
  });

  it('computes the round trip from the measured book', async () => {
    mocked.fetchOrderBookSpread.mockResolvedValue({ status: 'measured', spread: thinSpread });

    const enhanced = await enhanceQuoteWithSpread(baseQuote, USDC, USDY, 1000, 5.0);

    // 822.45 USDY sold back at the 1.082 bid.
    expect(enhanced.reverseQuote?.sellbackAmount).toBeCloseTo(889.89, 1);
    expect(enhanced.reverseQuote?.roundTripImpactPct).toBeCloseTo(5.46, 1);
  });

  it('reports an unreadable book as unknown, never as a zero spread', async () => {
    mocked.fetchOrderBookSpread.mockResolvedValue({
      status: 'unavailable',
      reason: 'The order book could not be read, so the spread is unknown.',
    });

    const enhanced = await enhanceQuoteWithSpread(baseQuote, USDC, USDY, 1000, 5.0);

    expect(enhanced.spread).toBeUndefined();
    expect(enhanced.impactAnalysis.spreadKnown).toBe(false);
    expect(enhanced.impactAnalysis.spreadPct).toBeNull();
    expect(enhanced.impactAnalysis.totalImpactPct).toBeNull();
    // Horizon's own, more specific reason is surfaced over the generic one.
    expect(enhanced.impactAnalysis.disclosure).toMatch(/could not be read/);
    // No reverse quote without real prices to compute it from.
    expect(enhanced.reverseQuote).toBeUndefined();
  });

  it('reports a pair with no order book as unknown, and still allows it', async () => {
    mocked.fetchOrderBookSpread.mockResolvedValue({ status: 'no-book' });

    const enhanced = await enhanceQuoteWithSpread(baseQuote, USDC, USDY, 1000, 5.0);

    expect(enhanced.impactAnalysis.spreadKnown).toBe(false);
    expect(enhanced.impactAnalysis.totalImpactPct).toBeNull();
    // An AMM-only pair is a normal case, so it is disclosed, not blocked...
    expect(enhanced.shouldRefuse).toBe(false);
    expect(enhanced.impactAnalysis.disclosure).toMatch(/could not be measured/i);
  });

  it('still refuses on price impact alone when the spread is unknown', async () => {
    mocked.fetchOrderBookSpread.mockResolvedValue({ status: 'no-book' });

    const enhanced = await enhanceQuoteWithSpread(
      { ...baseQuote, priceImpact: 0.09 }, // 9%
      USDC,
      USDY,
      1000,
      5.0,
    );

    expect(enhanced.shouldRefuse).toBe(true);
    expect(enhanced.refusalReason).toContain('9.00% price impact');
  });

  it('leaves the quote itself untouched', async () => {
    mocked.fetchOrderBookSpread.mockResolvedValue({ status: 'no-book' });

    const enhanced = await enhanceQuoteWithSpread(baseQuote, USDC, USDY, 1000, 5.0);

    expect(enhanced.amountOut).toBe(baseQuote.amountOut);
    expect(enhanced.path).toEqual(baseQuote.path);
    expect(enhanced.ttl).toBe(baseQuote.ttl);
  });
});

describe('calculateMinReceived', () => {
  it('applies slippage to the quoted output', () => {
    expect(calculateMinReceived(1000, 50)).toBe(995); // 0.5%
    expect(calculateMinReceived(1000, 100)).toBe(990); // 1%
    expect(calculateMinReceived(822.45, 50)).toBeCloseTo(818.338, 2);
  });
});

describe('formatHonestQuote', () => {
  function enhanced(over: Partial<HonestSwapQuote> = {}): HonestSwapQuote {
    const real = jest.requireActual<typeof spreadCalculator>('../spreadCalculator');
    return {
      ...baseQuote,
      impactAnalysis: real.analyzePriceImpact(0.5, 5.79, 5.0),
      shouldRefuse: true,
      refusalReason: 'Order exceeds 5% total impact threshold.',
      spread: thinSpread,
      reverseQuote: real.calculateReverseQuote(1000, 822.45, 1.082, 1.1445),
      ...over,
    };
  }

  it('formats a complete quote', () => {
    const out = formatHonestQuote(enhanced(), 1000, 'USDC');

    expect(out.amountOut).toBe('822.45');
    expect(out.rate).toBe('0.8225'); // 822.45 / 1000, dest per source
    expect(out.spread).toContain('5.79%');
    expect(out.impact).toContain('6.29% total');
    expect(out.sellback).toContain('USDC');
    expect(out.warning).toContain('exceeds');
  });

  it('says the spread was not measured rather than printing a total', () => {
    const real = jest.requireActual<typeof spreadCalculator>('../spreadCalculator');
    const out = formatHonestQuote(
      enhanced({
        spread: undefined,
        reverseQuote: undefined,
        shouldRefuse: false,
        refusalReason: undefined,
        impactAnalysis: real.analyzePriceImpact(0.5, null, 5.0),
      }),
      1000,
      'USDC',
    );

    expect(out.spread).toBeNull();
    expect(out.sellback).toBeNull();
    expect(out.warning).toBeNull();
    expect(out.impact).toBe('0.50% price impact (spread not measured)');
    expect(out.impact).not.toMatch(/total/);
    expect(out.disclosure).toMatch(/could not be measured/i);
  });

  it('refuses to invent a rate without an input amount', () => {
    const out = formatHonestQuote(enhanced(), 0, 'USDC');

    // The old version divided amountOut by itself and always printed "1.0000".
    expect(out.rate).toBe('—');
  });
});
