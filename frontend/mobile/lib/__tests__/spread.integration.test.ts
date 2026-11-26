/**
 * End-to-end spread scenarios for #732, run against the real analyzer.
 *
 * These are the cases the feature exists for: a thin USDC/USDY book where the
 * spread dwarfs the price impact, and the pairs where there is no book at all
 * and the honest answer is "we don't know" rather than "zero".
 */

import { analyzePriceImpact, calculateReverseQuote } from '../spreadCalculator';

describe('thin USDC/USDY book (#732)', () => {
  // Best bid 1.0820, best ask 1.1445 USDC per USDY — a 5.79% spread with only
  // a few hundred USDY resting on each side.
  const BID = 1.082;
  const ASK = 1.1445;
  const SPREAD_PCT = 5.79;

  it('refuses the order once the spread is counted', () => {
    const analysis = analyzePriceImpact(0.5, SPREAD_PCT, 5.0);

    // 0.5% impact alone would have passed; the spread is what makes it bad,
    // which is the entire argument for disclosing it before confirmation.
    expect(analysis.totalImpactPct).toBeCloseTo(6.29, 2);
    expect(analysis.exceedsThreshold).toBe(true);
    expect(analysis.refusalReason).toContain('6.29%');
    expect(analysis.refusalReason).toContain('threshold');
  });

  it('shows the real round-trip cost', () => {
    // 1000 USDC buys 873.74 USDY at the ask...
    const amountOut = 1000 / ASK;
    expect(amountOut).toBeCloseTo(873.74, 1);

    // ...and selling it straight back at the bid returns ~945.39 USDC.
    const round = calculateReverseQuote(1000, amountOut, BID, ASK);

    expect(round.sellbackAmount).toBeCloseTo(945.39, 1);
    expect(round.spreadLossPct).toBeCloseTo(5.46, 1);
    // The round trip crosses the spread once. The two figures therefore agree;
    // when the round-trip number was doubled they contradicted each other on
    // the same screen.
    expect(round.roundTripImpactPct).toBeCloseTo(5.46, 1);
    expect(round.roundTripImpactPct).toBeCloseTo(round.spreadLossPct, 0);
  });
});

describe('pairs with nothing to measure', () => {
  it('does not report a missing book as a zero spread', () => {
    const analysis = analyzePriceImpact(2.5, null, 5.0);

    expect(analysis.spreadPct).toBeNull();
    expect(analysis.totalImpactPct).toBeNull();
    expect(analysis.spreadKnown).toBe(false);
    expect(analysis.disclosure).toBeTruthy();
  });

  it('reports a real zero spread as a measurement', () => {
    const analysis = analyzePriceImpact(0.5, 0, 5.0);

    expect(analysis.spreadPct).toBe(0);
    expect(analysis.totalImpactPct).toBe(0.5);
    expect(analysis.spreadKnown).toBe(true);
    expect(analysis.disclosure).toBeUndefined();
  });

  it('keeps blocking a bad price impact even with no book', () => {
    expect(analyzePriceImpact(12, null, 5.0).exceedsThreshold).toBe(true);
  });
});

describe('threshold boundaries', () => {
  it('allows a total exactly at the threshold', () => {
    const analysis = analyzePriceImpact(2.0, 3.0, 5.0);

    expect(analysis.totalImpactPct).toBe(5.0);
    expect(analysis.exceedsThreshold).toBe(false);
  });

  it('refuses a total just over it', () => {
    const analysis = analyzePriceImpact(2.0, 3.01, 5.0);

    expect(analysis.totalImpactPct).toBeCloseTo(5.01, 2);
    expect(analysis.exceedsThreshold).toBe(true);
  });

  it('respects a lenient and a strict threshold on the same trade', () => {
    expect(analyzePriceImpact(2.0, 4.0, 10).exceedsThreshold).toBe(false);
    expect(analyzePriceImpact(2.0, 4.0, 1).exceedsThreshold).toBe(true);
  });
});

describe('a liquid pair', () => {
  it('allows a tight book and names both terms', () => {
    const analysis = analyzePriceImpact(0.35, 0.1, 5.0);

    expect(analysis.totalImpactPct).toBeCloseTo(0.45, 2);
    expect(analysis.exceedsThreshold).toBe(false);
    expect(analysis.disclosure).toBeUndefined();
  });

  it('leaves almost nothing on the table over a round trip', () => {
    const round = calculateReverseQuote(1000, 999.0, 1.0, 1.001);

    expect(round.spreadLossPct).toBeLessThan(0.2);
    expect(round.roundTripImpactPct).toBeLessThan(0.2);
  });
});
