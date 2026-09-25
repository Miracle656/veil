import { describe, it, expect, beforeEach } from '@jest/globals';
import { Horizon, Asset } from '@stellar/stellar-sdk';
import {
  enhanceQuoteWithSpread,
  calculateMinReceived,
  formatHonestQuote,
} from '../soroswapEnhanced';
import * as spreadCalculator from '../spreadCalculator';
import type { SwapQuote } from '../soroswap';

// Mock modules
jest.mock('../spreadCalculator');

describe('soroswapEnhanced', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('enhanceQuoteWithSpread', () => {
    it('should enhance quote with spread data', async () => {
      const baseQuote: SwapQuote = {
        amountOut: '8224500000', // 822.45 in stroops (7 decimals)
        priceImpact: 0.005, // 0.5%
        path: ['native'],
        protocols: ['SOROSWAP'],
        rawQuote: {},
        ttl: Date.now() + 30000,
      };

      const mockSpread = {
        bestBid: 1.0820,
        bestAsk: 1.1445,
        spreadPct: 5.79,
        bidCount: 2,
        askCount: 2,
        bidDepth: 800,
        askDepth: 600,
      };

      (spreadCalculator.fetchOrderBookSpread as jest.Mock).mockResolvedValue(mockSpread);
      (spreadCalculator.analyzePriceImpact as jest.Mock).mockReturnValue({
        priceImpactPct: 0.5,
        spreadPct: 5.79,
        totalImpactPct: 6.29,
        exceedsThreshold: true,
        refusalReason: 'Exceeds 5% threshold',
      });

      const enhanced = await enhanceQuoteWithSpread(
        baseQuote,
        'XLM',
        'USDC',
        1000,
        5.0,
      );

      expect(enhanced.spread).toEqual(mockSpread);
      expect(enhanced.impactAnalysis).toBeDefined();
      expect(enhanced.impactAnalysis?.totalImpactPct).toBe(6.29);
      expect(enhanced.shouldRefuse).toBe(true);
      expect(enhanced.refusalReason).toBe('Exceeds 5% threshold');
    });

    it('should refuse orders exceeding threshold', async () => {
      const baseQuote: SwapQuote = {
        amountOut: '8224500000',
        priceImpact: 0.02,
        path: ['native'],
        protocols: ['SOROSWAP'],
        rawQuote: {},
        ttl: Date.now() + 30000,
      };

      const mockSpread = {
        bestBid: 1.0820,
        bestAsk: 1.1445,
        spreadPct: 5.79,
        bidCount: 2,
        askCount: 2,
        bidDepth: 800,
        askDepth: 600,
      };

      (spreadCalculator.fetchOrderBookSpread as jest.Mock).mockResolvedValue(mockSpread);
      (spreadCalculator.analyzePriceImpact as jest.Mock).mockReturnValue({
        priceImpactPct: 2.0,
        spreadPct: 5.79,
        totalImpactPct: 7.79,
        exceedsThreshold: true,
        refusalReason: 'Order exceeds 5% threshold. Combined impact: 2.00% price impact + 5.79% spread = 7.79%',
      });

      const enhanced = await enhanceQuoteWithSpread(
        baseQuote,
        'XLM',
        'USDC',
        5000,
        5.0,
      );

      expect(enhanced.shouldRefuse).toBe(true);
      expect(enhanced.refusalReason).toContain('7.79%');
    });

    it('should calculate reverse quote for round-trip transparency', async () => {
      const baseQuote: SwapQuote = {
        amountOut: '8224500000', // 822.45
        priceImpact: 0.005,
        path: ['native'],
        protocols: ['SOROSWAP'],
        rawQuote: {},
        ttl: Date.now() + 30000,
      };

      const mockSpread = {
        bestBid: 1.0820,
        bestAsk: 1.1445,
        spreadPct: 5.79,
        bidCount: 2,
        askCount: 2,
        bidDepth: 800,
        askDepth: 600,
      };

      (spreadCalculator.fetchOrderBookSpread as jest.Mock).mockResolvedValue(mockSpread);
      (spreadCalculator.analyzePriceImpact as jest.Mock).mockReturnValue({
        priceImpactPct: 0.5,
        spreadPct: 5.79,
        totalImpactPct: 6.29,
        exceedsThreshold: true,
      });

      (spreadCalculator.calculateReverseQuote as jest.Mock).mockReturnValue({
        sellbackAmount: 889.27,
        spreadLossPct: 5.54,
        roundTripImpactPct: 11.58,
      });

      const enhanced = await enhanceQuoteWithSpread(
        baseQuote,
        'XLM',
        'USDC',
        1000,
        5.0,
      );

      expect(enhanced.reverseQuote).toBeDefined();
      expect(enhanced.reverseQuote?.sellbackAmount).toBeCloseTo(889.27, 1);
      expect(enhanced.reverseQuote?.spreadLossPct).toBeCloseTo(5.54, 1);
    });

    it('should handle fetch errors gracefully', async () => {
      const baseQuote: SwapQuote = {
        amountOut: '8224500000',
        priceImpact: 0.005,
        path: ['native'],
        protocols: ['SOROSWAP'],
        rawQuote: {},
        ttl: Date.now() + 30000,
      };

      (spreadCalculator.fetchOrderBookSpread as jest.Mock).mockRejectedValue(
        new Error('Network error'),
      );

      const enhanced = await enhanceQuoteWithSpread(
        baseQuote,
        'XLM',
        'USDC',
        1000,
        5.0,
      );

      // Should return base quote without enhancements
      expect(enhanced.amountOut).toBe(baseQuote.amountOut);
      expect(enhanced.spread).toBeUndefined();
      expect(enhanced.impactAnalysis).toBeUndefined();
    });

    it('should handle empty order book', async () => {
      const baseQuote: SwapQuote = {
        amountOut: '8224500000',
        priceImpact: 0.005,
        path: ['native'],
        protocols: ['SOROSWAP'],
        rawQuote: {},
        ttl: Date.now() + 30000,
      };

      (spreadCalculator.fetchOrderBookSpread as jest.Mock).mockResolvedValue(null);

      const enhanced = await enhanceQuoteWithSpread(
        baseQuote,
        'XLM',
        'USDC',
        1000,
        5.0,
      );

      // Should return base quote without spread analysis
      expect(enhanced.spread).toBeUndefined();
      expect(enhanced.impactAnalysis).toBeUndefined();
      expect(enhanced.shouldRefuse).toBeUndefined();
    });
  });

  describe('calculateMinReceived', () => {
    it('should calculate minimum received with slippage', () => {
      const minReceived = calculateMinReceived(822.45, 0.5, 5.79, 50);

      // 822.45 * (1 - 50 / 10000) = 822.45 * 0.995 = 817.74775
      expect(minReceived).toBeCloseTo(817.748, 2);
    });

    it('should handle 0.5% slippage', () => {
      const minReceived = calculateMinReceived(1000, 1.0, 2.0, 50);

      // 1000 * 0.995 = 995
      expect(minReceived).toBe(995);
    });

    it('should handle 1% slippage', () => {
      const minReceived = calculateMinReceived(1000, 1.0, 2.0, 100);

      // 1000 * 0.99 = 990
      expect(minReceived).toBe(990);
    });
  });

  describe('formatHonestQuote', () => {
    it('should format complete quote with all details', () => {
      const quote = {
        amountOut: '8224500000',
        priceImpact: 0.005,
        path: ['native'],
        protocols: ['SOROSWAP'],
        rawQuote: {},
        ttl: Date.now() + 30000,
        spread: {
          bestBid: 1.0820,
          bestAsk: 1.1445,
          spreadPct: 5.79,
          bidCount: 2,
          askCount: 2,
          bidDepth: 800,
          askDepth: 600,
        },
        impactAnalysis: {
          priceImpactPct: 0.5,
          spreadPct: 5.79,
          totalImpactPct: 6.29,
          exceedsThreshold: true,
          refusalReason: 'Exceeds 5% threshold',
        },
        reverseQuote: {
          sellbackAmount: 889.27,
          spreadLossPct: 5.54,
          roundTripImpactPct: 11.58,
        },
      };

      const formatted = formatHonestQuote(quote, 'XLM', 'USDC');

      expect(formatted.amountOut).toBe('822.45');
      expect(formatted.spread).toContain('5.79%');
      expect(formatted.spread).toContain('1.0820');
      expect(formatted.spread).toContain('1.1445');
      expect(formatted.impact).toContain('6.29%');
      expect(formatted.impact).toContain('0.50%');
      expect(formatted.impact).toContain('5.79%');
      expect(formatted.sellback).toContain('889.27');
      expect(formatted.sellback).toContain('5.54%');
      expect(formatted.warning).toContain('Exceeds 5% threshold');
    });

    it('should handle quote without spread data', () => {
      const quote = {
        amountOut: '8224500000',
        priceImpact: 0.005,
        path: ['native'],
        protocols: ['SOROSWAP'],
        rawQuote: {},
        ttl: Date.now() + 30000,
      };

      const formatted = formatHonestQuote(quote, 'XLM', 'USDC');

      expect(formatted.amountOut).toBe('822.45');
      expect(formatted.spread).toBeNull();
      expect(formatted.impact).toBeNull();
      expect(formatted.sellback).toBeNull();
      expect(formatted.warning).toBeNull();
    });

    it('should format warning when order should be refused', () => {
      const quote = {
        amountOut: '8224500000',
        priceImpact: 0.02,
        path: ['native'],
        protocols: ['SOROSWAP'],
        rawQuote: {},
        ttl: Date.now() + 30000,
        impactAnalysis: {
          priceImpactPct: 2.0,
          spreadPct: 5.79,
          totalImpactPct: 7.79,
          exceedsThreshold: true,
          refusalReason: 'Order exceeds 5% threshold',
        },
        shouldRefuse: true,
        refusalReason: 'Order exceeds 5% threshold',
      };

      const formatted = formatHonestQuote(quote, 'XLM', 'USDC');

      expect(formatted.warning).toBe('Order exceeds 5% threshold');
    });
  });
});
