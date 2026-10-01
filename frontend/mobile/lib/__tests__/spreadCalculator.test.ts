import { describe, it, expect, beforeEach } from '@jest/globals';
import { Horizon, Asset } from '@stellar/stellar-sdk';
import {
  fetchOrderBookSpread,
  analyzePriceImpact,
  calculateReverseQuote,
  formatSpreadDisplay,
  formatImpactDisplay,
} from '../spreadCalculator';

// Mock Horizon
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: jest.fn(),
  },
  Asset: {
    native: jest.fn(() => ({
      isNative: () => true,
      getCode: () => 'XLM',
      getIssuer: () => '',
    })),
  },
}));

describe('spreadCalculator', () => {
  describe('fetchOrderBookSpread', () => {
    it('should calculate spread from order book with bids and asks', async () => {
      const mockOrderBook = {
        bids: [
          { price: '1.0820', amount: '500' },
          { price: '1.0810', amount: '300' },
        ],
        asks: [
          { price: '1.1445', amount: '200' },
          { price: '1.1450', amount: '400' },
        ],
      };

      const mockServer = {
        orderbook: jest.fn(() => ({
          call: jest.fn().mockResolvedValue(mockOrderBook),
        })),
      };

      (Horizon.Server as jest.Mock).mockReturnValue(mockServer);

      const source = Asset.native();
      const dest = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

      const spread = await fetchOrderBookSpread(source, dest);

      expect(spread).toBeDefined();
      expect(spread!.bestBid).toBe(1.082);
      expect(spread!.bestAsk).toBe(1.1445);
      expect(spread!.bidCount).toBe(2);
      expect(spread!.askCount).toBe(2);
      expect(spread!.bidDepth).toBe(800); // 500 + 300
      expect(spread!.askDepth).toBe(600); // 200 + 400

      // Spread percentage: (1.1445 - 1.082) / 1.082 * 100 ≈ 5.79%
      expect(spread!.spreadPct).toBeCloseTo(5.79, 1);
    });

    it('should return null for empty order book', async () => {
      const mockOrderBook = {
        bids: [],
        asks: [],
      };

      const mockServer = {
        orderbook: jest.fn(() => ({
          call: jest.fn().mockResolvedValue(mockOrderBook),
        })),
      };

      (Horizon.Server as jest.Mock).mockReturnValue(mockServer);

      const source = Asset.native();
      const dest = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

      const spread = await fetchOrderBookSpread(source, dest);

      expect(spread).toBeNull();
    });

    it('should handle fetch errors gracefully', async () => {
      const mockServer = {
        orderbook: jest.fn(() => ({
          call: jest.fn().mockRejectedValue(new Error('Network error')),
        })),
      };

      (Horizon.Server as jest.Mock).mockReturnValue(mockServer);

      const source = Asset.native();
      const dest = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

      const spread = await fetchOrderBookSpread(source, dest);

      expect(spread).toBeNull();
    });
  });

  describe('analyzePriceImpact', () => {
    it('should calculate total impact and allow normal orders', () => {
      const analysis = analyzePriceImpact(0.5, 2.0, 5.0);

      expect(analysis.priceImpactPct).toBe(0.5);
      expect(analysis.spreadPct).toBe(2.0);
      expect(analysis.totalImpactPct).toBe(2.5);
      expect(analysis.exceedsThreshold).toBe(false);
      expect(analysis.refusalReason).toBeUndefined();
    });

    it('should refuse orders exceeding threshold', () => {
      const analysis = analyzePriceImpact(2.0, 4.5, 5.0);

      expect(analysis.priceImpactPct).toBe(2.0);
      expect(analysis.spreadPct).toBe(4.5);
      expect(analysis.totalImpactPct).toBe(6.5);
      expect(analysis.exceedsThreshold).toBe(true);
      expect(analysis.refusalReason).toContain('6.50%');
      expect(analysis.refusalReason).toContain('threshold');
    });

    it('should handle thin book (5.8% spread) with low price impact', () => {
      // Realistic thin book scenario from issue #732
      const analysis = analyzePriceImpact(0.05, 5.79, 5.0);

      expect(analysis.totalImpactPct).toBeCloseTo(5.84, 1);
      expect(analysis.exceedsThreshold).toBe(true);
      expect(analysis.refusalReason).toContain('5.84%');
    });

    it('should handle empty book (no spread)', () => {
      const analysis = analyzePriceImpact(2.5, null, 5.0);

      expect(analysis.priceImpactPct).toBe(2.5);
      expect(analysis.spreadPct).toBe(0);
      expect(analysis.totalImpactPct).toBe(2.5);
      expect(analysis.exceedsThreshold).toBe(false);
    });

    it('should use custom threshold', () => {
      const analysis = analyzePriceImpact(3.0, 2.0, 4.0);

      expect(analysis.totalImpactPct).toBe(5.0);
      expect(analysis.exceedsThreshold).toBe(true);
    });
  });

  describe('calculateReverseQuote', () => {
    it('should calculate round-trip cost for buying at ask and selling at bid', () => {
      const amountIn = 1000; // USDC
      const amountOut = 922.5; // USDY at price 1.0820 (ask)
      const bestBid = 1.0820;
      const bestAsk = 1.1445;

      const result = calculateReverseQuote(amountIn, amountOut, bestBid, bestAsk);

      // When selling 922.5 USDY at best bid of 1.0820, get: 922.5 * 1.0820 ≈ 997.695
      expect(result.sellbackAmount).toBeCloseTo(997.695, 1);

      // Loss = 1000 - 997.695 = 2.305 USDC, or 0.2305%
      expect(result.spreadLossPct).toBeCloseTo(0.23, 1);

      // Round trip impact = (ask - bid) / bid * 2 * 100
      // = (1.1445 - 1.0820) / 1.0820 * 2 * 100 ≈ 11.58%
      expect(result.roundTripImpactPct).toBeCloseTo(11.58, 1);
    });

    it('should show 0 loss with identical bid-ask', () => {
      const amountIn = 1000;
      const amountOut = 1000;
      const bestBid = 1.0;
      const bestAsk = 1.0;

      const result = calculateReverseQuote(amountIn, amountOut, bestBid, bestAsk);

      expect(result.sellbackAmount).toBe(1000);
      expect(result.spreadLossPct).toBe(0);
      expect(result.roundTripImpactPct).toBe(0);
    });

    it('should show large loss with thin book', () => {
      // Thin book: best bid 1.0820, best ask 1.1445 (5.8% spread)
      const amountIn = 1000;
      const amountOut = 873.47; // 1000 / 1.1445
      const bestBid = 1.0820;
      const bestAsk = 1.1445;

      const result = calculateReverseQuote(amountIn, amountOut, bestBid, bestAsk);

      // When selling 873.47 USDY at 1.0820, get: 873.47 * 1.0820 ≈ 944.64 USDC
      expect(result.sellbackAmount).toBeCloseTo(944.64, 1);

      // Loss = 1000 - 944.64 = 55.36, or 5.536%
      expect(result.spreadLossPct).toBeCloseTo(5.54, 1);
    });
  });

  describe('formatSpreadDisplay', () => {
    it('should format spread data for UI display', () => {
      const spread = {
        bestBid: 1.0820,
        bestAsk: 1.1445,
        spreadPct: 5.79,
        bidCount: 2,
        askCount: 2,
        bidDepth: 800,
        askDepth: 600,
      };

      const formatted = formatSpreadDisplay(spread);

      expect(formatted.bid).toBe('1.0820');
      expect(formatted.ask).toBe('1.1445');
      expect(formatted.spreadPct).toBe('5.79');
      expect(formatted.depth).toBe('800 / 600');
    });
  });

  describe('formatImpactDisplay', () => {
    it('should format impact as ok when below 2%', () => {
      const analysis = {
        priceImpactPct: 0.5,
        spreadPct: 1.0,
        totalImpactPct: 1.5,
        exceedsThreshold: false,
      };

      const formatted = formatImpactDisplay(analysis);

      expect(formatted.totalImpactPct).toBe('1.50');
      expect(formatted.status).toBe('ok');
      expect(formatted.breakdown).toContain('0.50%');
      expect(formatted.breakdown).toContain('1.00%');
    });

    it('should format impact as warning between 2-5%', () => {
      const analysis = {
        priceImpactPct: 1.0,
        spreadPct: 2.5,
        totalImpactPct: 3.5,
        exceedsThreshold: false,
      };

      const formatted = formatImpactDisplay(analysis);

      expect(formatted.totalImpactPct).toBe('3.50');
      expect(formatted.status).toBe('warning');
    });

    it('should format impact as error when exceeding threshold', () => {
      const analysis = {
        priceImpactPct: 2.0,
        spreadPct: 4.5,
        totalImpactPct: 6.5,
        exceedsThreshold: true,
        refusalReason: 'Exceeds 5% threshold',
      };

      const formatted = formatImpactDisplay(analysis);

      expect(formatted.totalImpactPct).toBe('6.50');
      expect(formatted.status).toBe('error');
    });

    it('should handle zero spread', () => {
      const analysis = {
        priceImpactPct: 2.5,
        spreadPct: 0,
        totalImpactPct: 2.5,
        exceedsThreshold: false,
      };

      const formatted = formatImpactDisplay(analysis);

      expect(formatted.breakdown).toBe('2.50% price impact');
    });
  });
});
