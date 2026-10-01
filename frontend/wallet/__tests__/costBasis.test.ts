/**
 * Tests for cost basis tracking system
 * Covers:
 * - Multiple purchases at different prices (weighted average)
 * - Partial sells (FIFO)
 * - Price falls (losses)
 * - Data persistence across restarts
 */

import {
  CostBasisStore,
  CostEntry,
  calculateYieldMetrics,
  isLoss,
  isGain,
  hasPosition,
} from '../lib/costBasis';

// Mock localStorage for testing
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

describe('CostBasisStore', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('single purchase', () => {
    it('should record a single purchase', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      const entry: CostEntry = {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      };

      store.addEntry('USDY', 'ISSUER1', entry);
      
      const entries = store.getEntries('USDY', 'ISSUER1');
      expect(entries).toHaveLength(1);
      expect(entries[0].quantity).toBe(100);
      expect(entries[0].purchasePrice).toBe(1.0);
    });

    it('should calculate weighted average for single purchase', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      const weightedAvg = store.getWeightedAveragePrice('USDY', 'ISSUER1');
      expect(weightedAvg).toBe(1.0);
    });

    it('should calculate total cost basis', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      const costBasis = store.getTotalCostBasis('USDY', 'ISSUER1');
      expect(costBasis).toBe(100);
    });
  });

  describe('multiple purchases at different prices', () => {
    it('should record multiple purchases', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.1,
        purchaseTimestamp: new Date('2024-01-02').toISOString(),
        transactionHash: 'hash2',
        purchaseType: 'swap',
      });

      const entries = store.getEntries('USDY', 'ISSUER1');
      expect(entries).toHaveLength(2);
      expect(entries[0].quantity).toBe(100);
      expect(entries[1].quantity).toBe(100);
    });

    it('should calculate correct weighted average for multiple purchases', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      // Buy 100 at $1.00
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      // Buy 100 at $1.10
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.1,
        purchaseTimestamp: new Date('2024-01-02').toISOString(),
        transactionHash: 'hash2',
        purchaseType: 'swap',
      });

      const weightedAvg = store.getWeightedAveragePrice('USDY', 'ISSUER1');
      // (100 * 1.0 + 100 * 1.1) / 200 = 210 / 200 = 1.05
      expect(weightedAvg).toBeCloseTo(1.05, 5);
    });

    it('should calculate total quantity correctly', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      store.addEntry('USDY', 'ISSUER1', {
        quantity: 150,
        purchasePrice: 1.1,
        purchaseTimestamp: new Date('2024-01-02').toISOString(),
        transactionHash: 'hash2',
        purchaseType: 'swap',
      });

      const totalQty = store.getTotalQuantity('USDY', 'ISSUER1');
      expect(totalQty).toBe(250);
    });

    it('should calculate total cost basis correctly', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.1,
        purchaseTimestamp: new Date('2024-01-02').toISOString(),
        transactionHash: 'hash2',
        purchaseType: 'swap',
      });

      const costBasis = store.getTotalCostBasis('USDY', 'ISSUER1');
      // (100 * 1.0) + (100 * 1.1) = 100 + 110 = 210
      expect(costBasis).toBe(210);
    });
  });

  describe('partial sells', () => {
    it('should sell full lot (FIFO)', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      const sold = store.recordSale('USDY', 'ISSUER1', 100);
      
      expect(sold).toHaveLength(1);
      expect(sold[0].quantity).toBe(100);
      expect(store.getTotalQuantity('USDY', 'ISSUER1')).toBe(0);
    });

    it('should sell partial lot (FIFO)', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      const sold = store.recordSale('USDY', 'ISSUER1', 40);
      
      expect(sold).toHaveLength(1);
      expect(sold[0].quantity).toBe(40);
      expect(store.getTotalQuantity('USDY', 'ISSUER1')).toBe(60);
    });

    it('should apply FIFO when selling multiple lots', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      // First purchase: 100 at $1.00
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      // Second purchase: 100 at $1.10
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.1,
        purchaseTimestamp: new Date('2024-01-02').toISOString(),
        transactionHash: 'hash2',
        purchaseType: 'swap',
      });

      // Sell 150 (all of first lot + 50 from second)
      const sold = store.recordSale('USDY', 'ISSUER1', 150);
      
      expect(sold).toHaveLength(2);
      expect(sold[0].quantity).toBe(100);
      expect(sold[0].purchasePrice).toBe(1.0);
      expect(sold[1].quantity).toBe(50);
      expect(sold[1].purchasePrice).toBe(1.1);
      
      // Remaining: 50 at $1.10
      const remaining = store.getEntries('USDY', 'ISSUER1');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].quantity).toBe(50);
      expect(remaining[0].purchasePrice).toBe(1.1);
    });

    it('should calculate realized gain/loss correctly on partial sale', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      // Sell 100 at $1.20 = profit of $20
      const gainLoss = store.calculateRealizedGainLoss('USDY', 'ISSUER1', 1.2, 100);
      expect(gainLoss).toBe(20);
    });
  });

  describe('price falls (losses)', () => {
    it('should track unrealized loss when price falls', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      const entries = store.getEntries('USDY', 'ISSUER1');
      const metrics = calculateYieldMetrics(entries, 0.9); // Price fell to $0.90
      
      expect(metrics.unrealizedGainLoss).toBe(-10);
      expect(metrics.unrealizedGainLossPercent).toBeCloseTo(-10, 5);
      expect(isLoss(metrics)).toBe(true);
    });

    it('should show negative change description on loss', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      const entries = store.getEntries('USDY', 'ISSUER1');
      const metrics = calculateYieldMetrics(entries, 0.8);
      
      expect(metrics.changeDescription).toContain('-20.00');
      expect(metrics.changeDescription).toContain('-20.00%');
    });

    it('should calculate realized loss on sale below cost', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      // Sell 100 at $0.85 = loss of $15
      const gainLoss = store.calculateRealizedGainLoss('USDY', 'ISSUER1', 0.85, 100);
      expect(gainLoss).toBe(-15);
    });
  });

  describe('data persistence', () => {
    it('should survive restart (localStorage persists)', () => {
      // First store instance
      let store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      // "Restart" - create new store instance
      store = new CostBasisStore('testnet', 'GTEST123');
      
      const entries = store.getEntries('USDY', 'ISSUER1');
      expect(entries).toHaveLength(1);
      expect(entries[0].quantity).toBe(100);
    });

    it('should track multiple assets separately', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      store.addEntry('EURC', 'ISSUER2', {
        quantity: 50,
        purchasePrice: 1.1,
        purchaseTimestamp: new Date('2024-01-02').toISOString(),
        transactionHash: 'hash2',
        purchaseType: 'swap',
      });

      const usdyEntries = store.getEntries('USDY', 'ISSUER1');
      const eurcEntries = store.getEntries('EURC', 'ISSUER2');
      
      expect(usdyEntries).toHaveLength(1);
      expect(eurcEntries).toHaveLength(1);
      expect(usdyEntries[0].quantity).toBe(100);
      expect(eurcEntries[0].quantity).toBe(50);
    });

    it('should export and import data correctly', () => {
      let store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      const exported = store.export();
      
      // Clear and reimport
      localStorage.clear();
      store = new CostBasisStore('testnet', 'GTEST123');
      store.import(exported);
      
      const entries = store.getEntries('USDY', 'ISSUER1');
      expect(entries).toHaveLength(1);
      expect(entries[0].quantity).toBe(100);
    });
  });

  describe('yield metrics calculation', () => {
    it('should calculate metrics for gain scenario', () => {
      const entries: CostEntry[] = [
        {
          quantity: 100,
          purchasePrice: 1.0,
          purchaseTimestamp: new Date('2024-01-01').toISOString(),
          transactionHash: 'hash1',
          purchaseType: 'payment_received',
        },
      ];

      const metrics = calculateYieldMetrics(entries, 1.15);
      
      expect(metrics.quantity).toBe(100);
      expect(metrics.totalCostBasis).toBe(100);
      expect(metrics.currentValue).toBe(115);
      expect(metrics.unrealizedGainLoss).toBe(15);
      expect(metrics.unrealizedGainLossPercent).toBeCloseTo(15, 5);
      expect(isGain(metrics)).toBe(true);
      expect(hasPosition(metrics)).toBe(true);
    });

    it('should calculate metrics for loss scenario', () => {
      const entries: CostEntry[] = [
        {
          quantity: 100,
          purchasePrice: 1.0,
          purchaseTimestamp: new Date('2024-01-01').toISOString(),
          transactionHash: 'hash1',
          purchaseType: 'payment_received',
        },
      ];

      const metrics = calculateYieldMetrics(entries, 0.85);
      
      expect(metrics.quantity).toBe(100);
      expect(metrics.totalCostBasis).toBe(100);
      expect(metrics.currentValue).toBe(85);
      expect(metrics.unrealizedGainLoss).toBe(-15);
      expect(metrics.unrealizedGainLossPercent).toBeCloseTo(-15, 5);
      expect(isLoss(metrics)).toBe(true);
    });

    it('should handle no position', () => {
      const entries: CostEntry[] = [];
      const metrics = calculateYieldMetrics(entries, 1.0);
      
      expect(metrics.quantity).toBe(0);
      expect(metrics.totalCostBasis).toBe(0);
      expect(hasPosition(metrics)).toBe(false);
    });

    it('should track period covered (date range)', () => {
      const entries: CostEntry[] = [
        {
          quantity: 100,
          purchasePrice: 1.0,
          purchaseTimestamp: new Date('2024-01-01').toISOString(),
          transactionHash: 'hash1',
          purchaseType: 'payment_received',
        },
        {
          quantity: 50,
          purchasePrice: 1.1,
          purchaseTimestamp: new Date('2024-01-15').toISOString(),
          transactionHash: 'hash2',
          purchaseType: 'swap',
        },
      ];

      const metrics = calculateYieldMetrics(entries, 1.2);
      
      expect(metrics.periodStart).toBeDefined();
      expect(metrics.periodEnd).toBeDefined();
      expect(new Date(metrics.periodStart!).getTime()).toBeLessThan(new Date(metrics.periodEnd!).getTime());
    });
  });

  describe('edge cases', () => {
    it('should handle zero quantity gracefully', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      const weightedAvg = store.getWeightedAveragePrice('USDY', 'ISSUER1');
      expect(weightedAvg).toBe(0);
    });

    it('should handle non-existent asset', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      const entries = store.getEntries('USDY', 'ISSUER1');
      expect(entries).toEqual([]);
    });

    it('should handle selling more than held (graceful degradation)', () => {
      const store = new CostBasisStore('testnet', 'GTEST123');
      
      store.addEntry('USDY', 'ISSUER1', {
        quantity: 100,
        purchasePrice: 1.0,
        purchaseTimestamp: new Date('2024-01-01').toISOString(),
        transactionHash: 'hash1',
        purchaseType: 'payment_received',
      });

      // Try to sell 150 (more than held)
      const sold = store.recordSale('USDY', 'ISSUER1', 150);
      
      // Should only sell what's available
      expect(sold).toHaveLength(1);
      expect(sold[0].quantity).toBe(100);
    });
  });
});
