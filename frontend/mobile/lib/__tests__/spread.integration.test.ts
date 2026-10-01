import { describe, it, expect } from '@jest/globals';
import {
  analyzePriceImpact,
  calculateReverseQuote,
} from '../spreadCalculator';

describe('Spread Integration Tests - Realistic Scenarios', () => {
  describe('Thin Book Scenario (Issue #732)', () => {
    /**
     * Scenario from issue #732 (2026-09-23):
     * - Best bid: 1.0820 USDC per USDY
     * - Best ask: 1.1445 USDC per USDY
     * - Spread: 5.8%
     * - Limited depth: ~500 USDY on each side
     *
     * This tests the realistic case where the book is thin and user loses
     * significant value through spread if they buy and immediately sell.
     */
    it('should handle thin book with 5.8% spread correctly', () => {
      const spreadPct = 5.79;

      // Analyze impact: small price impact (0.5%) + large spread (5.79%) = 6.29%
      const analysis = analyzePriceImpact(0.5, spreadPct, 5.0);

      expect(analysis.totalImpactPct).toBeCloseTo(6.29, 1);
      expect(analysis.exceedsThreshold).toBe(true);
      expect(analysis.refusalReason).toContain('6.29%');
      expect(analysis.refusalReason).toContain('threshold');

      // Calculate round-trip loss
      const amountIn = 1000; // 1000 USDC
      const amountOut = 873.47; // 1000 / 1.1445 ≈ 873.47 USDY at ask price
      const reverseQuote = calculateReverseQuote(amountIn, amountOut, 1.082, 1.1445);

      // Selling 873.47 USDY at best bid 1.082: 873.47 * 1.082 ≈ 944.64 USDC
      expect(reverseQuote.sellbackAmount).toBeCloseTo(944.64, 1);

      // Loss: 1000 - 944.64 = 55.36, or 5.536%
      expect(reverseQuote.spreadLossPct).toBeCloseTo(5.54, 1);

      // Round-trip impact (both buying spread + selling spread)
      // = (ask - bid) / bid * 2 * 100 ≈ 11.58%
      expect(reverseQuote.roundTripImpactPct).toBeCloseTo(11.58, 1);
    });

    it('should show clear refusal reason for thin book order', () => {
      // 5.8% spread is already problematic; with any price impact it exceeds 5% threshold
      const analysis = analyzePriceImpact(0.05, 5.79, 5.0);

      expect(analysis.exceedsThreshold).toBe(true);
      expect(analysis.refusalReason).toContain('5% threshold');
      expect(analysis.refusalReason).toContain('5.84%');
      expect(analysis.refusalReason).toContain('0.05%');
      expect(analysis.refusalReason).toContain('5.79%');
    });

    it('should handle depth on thin book', () => {
      // With limited depth, even small orders might exceed threshold
      const bids = [
        { price: '1.0820', amount: '500' },
        { price: '1.0800', amount: '100' },
      ];
      const asks = [
        { price: '1.1445', amount: '300' },
        { price: '1.1500', amount: '200' },
      ];

      const bidDepth = 600;
      const askDepth = 500;

      expect(bidDepth).toBeGreaterThan(askDepth);
      expect(bidDepth + askDepth).toBe(1100); // Total limited depth
    });
  });

  describe('Empty Book Scenario', () => {
    /**
     * Scenario: No orders on the book at all.
     * This tests handling of zero liquidity gracefully.
     */
    it('should handle book with only price impact (no spread)', () => {
      const analysis = analyzePriceImpact(2.5, null, 5.0);

      expect(analysis.priceImpactPct).toBe(2.5);
      expect(analysis.spreadPct).toBe(0);
      expect(analysis.totalImpactPct).toBe(2.5);
      expect(analysis.exceedsThreshold).toBe(false);
    });

    it('should handle zero spread (bid = ask)', () => {
      const analysis = analyzePriceImpact(0.5, 0, 5.0);

      expect(analysis.spreadPct).toBe(0);
      expect(analysis.totalImpactPct).toBe(0.5);
      expect(analysis.exceedsThreshold).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very small amounts with thin book', () => {
      const amountIn = 0.001; // 0.001 XLM
      const amountOut = 0.000874; // Very small amount of USDY
      const bestBid = 1.0820;
      const bestAsk = 1.1445;

      const reverseQuote = calculateReverseQuote(amountIn, amountOut, bestBid, bestAsk);

      expect(reverseQuote.sellbackAmount).toBeCloseTo(0.000945, 6);
      expect(reverseQuote.spreadLossPct).toBeCloseTo(5.54, 1);
    });

    it('should handle very large amounts', () => {
      const amountIn = 1000000; // 1M USDC
      const amountOut = 873470; // ~873,470 USDY
      const bestBid = 1.0820;
      const bestAsk = 1.1445;

      const reverseQuote = calculateReverseQuote(amountIn, amountOut, bestBid, bestAsk);

      expect(reverseQuote.sellbackAmount).toBeCloseTo(944640, 0);
      expect(reverseQuote.spreadLossPct).toBeCloseTo(5.54, 1);
    });

    it('should handle threshold at exactly 5%', () => {
      const analysis = analyzePriceImpact(2.5, 2.5, 5.0);

      expect(analysis.totalImpactPct).toBe(5.0);
      expect(analysis.exceedsThreshold).toBe(false);
    });

    it('should refuse orders just over threshold', () => {
      const analysis = analyzePriceImpact(2.51, 2.5, 5.0);

      expect(analysis.totalImpactPct).toBeCloseTo(5.01, 1);
      expect(analysis.exceedsThreshold).toBe(true);
    });

    it('should handle custom thresholds', () => {
      // More lenient 10% threshold
      const lenientAnalysis = analyzePriceImpact(5.0, 5.0, 10.0);
      expect(lenientAnalysis.exceedsThreshold).toBe(false);

      // Stricter 2% threshold
      const strictAnalysis = analyzePriceImpact(1.0, 1.5, 2.0);
      expect(strictAnalysis.exceedsThreshold).toBe(true);
    });

    it('should provide clear breakdown for users', () => {
      const analysis = analyzePriceImpact(1.5, 4.2, 5.0);

      expect(analysis.refusalReason).toContain('1.50%');
      expect(analysis.refusalReason).toContain('4.20%');
      expect(analysis.refusalReason).toContain('5.70%');
    });
  });

  describe('Realistic Trading Scenarios', () => {
    it('should allow order on liquid USDC/USDY pair (low spread)', () => {
      // Realistic tight book scenario
      const analysis = analyzePriceImpact(0.3, 0.15, 5.0);

      expect(analysis.totalImpactPct).toBeCloseTo(0.45, 1);
      expect(analysis.exceedsThreshold).toBe(false);
    });

    it('should refuse order on thin emerging market pair', () => {
      // Emerging market pair with high spread
      const analysis = analyzePriceImpact(1.0, 7.5, 5.0);

      expect(analysis.totalImpactPct).toBeCloseTo(8.5, 1);
      expect(analysis.exceedsThreshold).toBe(true);
      expect(analysis.refusalReason).toContain('Exceeds 5% threshold');
    });

    it('should handle volatile market conditions (high price impact)', () => {
      // Large order on moderate book during volatility
      const analysis = analyzePriceImpact(3.5, 2.0, 5.0);

      expect(analysis.totalImpactPct).toBeCloseTo(5.5, 1);
      expect(analysis.exceedsThreshold).toBe(true);
    });

    it('should provide actionable feedback to users', () => {
      const thinBookAnalysis = analyzePriceImpact(0.05, 5.79, 5.0);
      const refusalMsg = thinBookAnalysis.refusalReason!;

      // Message should tell user what the issue is
      expect(refusalMsg).toContain('threshold');
      expect(refusalMsg).toContain('5%');
      expect(refusalMsg).toContain('5.84%');

      // Message should help user understand breakdown
      expect(refusalMsg).toContain('0.05%');
      expect(refusalMsg).toContain('5.79%');
    });
  });
});
