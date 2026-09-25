/**
 * Cost Basis Tracking System
 * 
 * Tracks user purchases per asset to calculate:
 * - Weighted average cost basis
 * - Realized and unrealized gains/losses
 * - Change in value since purchase (in USDC and percent)
 * 
 * This accurately reflects how yield works for price-accrual assets like USDY,
 * which don't grow token count but instead grow price per token.
 */

export interface CostEntry {
  /** Quantity of asset purchased */
  quantity: number;
  /** Price paid per unit in USDC */
  purchasePrice: number;
  /** ISO timestamp of purchase */
  purchaseTimestamp: string;
  /** Transaction hash for reference */
  transactionHash: string;
  /** Purchase type: 'swap', 'payment_received', 'airdrop', etc. */
  purchaseType: 'swap' | 'payment_received' | 'airdrop' | 'manual' | 'other';
  /** Optional memo or description */
  memo?: string;
}

export interface AssetCostBasis {
  /** Asset code (e.g., 'USDY', 'EURC') */
  code: string;
  /** Asset issuer account ID */
  issuer: string;
  /** Array of purchase entries */
  entries: CostEntry[];
  /** ISO timestamp of last update */
  lastUpdated: string;
}

export interface CostBasisData {
  /** Network identifier (testnet, public) */
  network: string;
  /** Wallet address that owns the assets */
  walletAddress: string;
  /** Timestamp when this data was saved */
  savedAt: string;
  /** All tracked assets */
  assets: AssetCostBasis[];
}

/**
 * CostBasisStore - Manages persistent cost basis data in localStorage
 * Survives app restarts and provides ACID-like operations for asset tracking
 */
export class CostBasisStore {
  private storageKey: string;
  private network: string;
  private walletAddress: string;

  constructor(network: string, walletAddress: string) {
    this.network = network;
    this.walletAddress = walletAddress;
    this.storageKey = `veil_cost_basis:${network}:${walletAddress}`;
  }

  /**
   * Load all cost basis data from storage
   */
  private load(): CostBasisData {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (!stored) {
        return {
          network: this.network,
          walletAddress: this.walletAddress,
          savedAt: new Date().toISOString(),
          assets: [],
        };
      }
      return JSON.parse(stored);
    } catch (error) {
      console.error('Failed to load cost basis data:', error);
      return {
        network: this.network,
        walletAddress: this.walletAddress,
        savedAt: new Date().toISOString(),
        assets: [],
      };
    }
  }

  /**
   * Save all cost basis data to storage
   */
  private save(data: CostBasisData): void {
    try {
      data.savedAt = new Date().toISOString();
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save cost basis data:', error);
    }
  }

  /**
   * Add a purchase entry for an asset
   */
  addEntry(code: string, issuer: string, entry: CostEntry): void {
    const data = this.load();
    let asset = data.assets.find(a => a.code === code && a.issuer === issuer);
    
    if (!asset) {
      asset = {
        code,
        issuer,
        entries: [],
        lastUpdated: new Date().toISOString(),
      };
      data.assets.push(asset);
    }

    asset.entries.push(entry);
    asset.lastUpdated = new Date().toISOString();
    this.save(data);
  }

  /**
   * Record a partial or full sale - reduces quantity from cost basis
   * Uses FIFO (First In, First Out) by default
   */
  recordSale(code: string, issuer: string, quantitySold: number): CostEntry[] {
    const data = this.load();
    const asset = data.assets.find(a => a.code === code && a.issuer === issuer);
    
    if (!asset || asset.entries.length === 0) {
      console.warn(`No cost basis found for ${code}/${issuer}`);
      return [];
    }

    const soldEntries: CostEntry[] = [];
    let remainingToSell = quantitySold;

    // FIFO: sell from oldest entries first
    for (let i = 0; i < asset.entries.length && remainingToSell > 0; i++) {
      const entry = asset.entries[i];
      const quantityToSell = Math.min(entry.quantity, remainingToSell);

      if (quantityToSell === entry.quantity) {
        // Full entry sold
        soldEntries.push(entry);
        asset.entries.splice(i, 1);
        i--; // Adjust index after splice
      } else {
        // Partial entry sold
        const partialSold = { ...entry, quantity: quantityToSell };
        soldEntries.push(partialSold);
        entry.quantity -= quantityToSell;
      }

      remainingToSell -= quantityToSell;
    }

    asset.lastUpdated = new Date().toISOString();
    this.save(data);
    return soldEntries;
  }

  /**
   * Get all cost basis entries for an asset
   */
  getEntries(code: string, issuer: string): CostEntry[] {
    const data = this.load();
    const asset = data.assets.find(a => a.code === code && a.issuer === issuer);
    return asset?.entries ?? [];
  }

  /**
   * Get total quantity held (sum of all entries)
   */
  getTotalQuantity(code: string, issuer: string): number {
    const entries = this.getEntries(code, issuer);
    return entries.reduce((sum, entry) => sum + entry.quantity, 0);
  }

  /**
   * Get total cost basis (sum of all entries * purchase price)
   */
  getTotalCostBasis(code: string, issuer: string): number {
    const entries = this.getEntries(code, issuer);
    return entries.reduce((sum, entry) => sum + entry.quantity * entry.purchasePrice, 0);
  }

  /**
   * Get weighted average purchase price
   */
  getWeightedAveragePrice(code: string, issuer: string): number {
    const entries = this.getEntries(code, issuer);
    const totalQuantity = entries.reduce((sum, entry) => sum + entry.quantity, 0);
    
    if (totalQuantity === 0) return 0;

    const totalCost = entries.reduce((sum, entry) => sum + entry.quantity * entry.purchasePrice, 0);
    return totalCost / totalQuantity;
  }

  /**
   * Calculate realized gain/loss for a sale
   */
  calculateRealizedGainLoss(code: string, issuer: string, salePrice: number, quantitySold: number): number {
    const entries = this.getEntries(code, issuer);
    let costOfSoldUnits = 0;
    let remaining = quantitySold;

    // FIFO: cost of sold units from oldest entries first
    for (const entry of entries) {
      if (remaining <= 0) break;
      const quantityFromThisEntry = Math.min(entry.quantity, remaining);
      costOfSoldUnits += quantityFromThisEntry * entry.purchasePrice;
      remaining -= quantityFromThisEntry;
    }

    const proceeds = quantitySold * salePrice;
    return proceeds - costOfSoldUnits;
  }

  /**
   * Get all assets with cost basis data
   */
  getAllAssets(): AssetCostBasis[] {
    const data = this.load();
    return data.assets;
  }

  /**
   * Clear all cost basis data (use with caution)
   */
  clear(): void {
    localStorage.removeItem(this.storageKey);
  }

  /**
   * Export cost basis data for backup
   */
  export(): CostBasisData {
    return this.load();
  }

  /**
   * Import cost basis data (overwrites existing data)
   */
  import(data: CostBasisData): void {
    if (data.network !== this.network || data.walletAddress !== this.walletAddress) {
      throw new Error('Network or wallet address mismatch during import');
    }
    this.save(data);
  }
}

/**
 * CostBasisCalculator - Computes yield metrics based on cost basis and current price
 */
export interface YieldMetrics {
  /** Total units held */
  quantity: number;
  /** Weighted average purchase price (USDC per unit) */
  weightedAveragePrice: number;
  /** Total amount paid (USDC) */
  totalCostBasis: number;
  /** Current price per unit (USDC) */
  currentPrice: number;
  /** Current total value (USDC) */
  currentValue: number;
  /** Unrealized gain/loss (USDC) */
  unrealizedGainLoss: number;
  /** Unrealized gain/loss as percentage */
  unrealizedGainLossPercent: number;
  /** Date of oldest purchase (for "period covered" display) */
  periodStart?: string;
  /** Latest purchase date */
  periodEnd?: string;
  /** Description of change for display */
  changeDescription: string;
}

export function calculateYieldMetrics(
  entries: CostEntry[],
  currentPrice: number,
): YieldMetrics {
  const quantity = entries.reduce((sum, e) => sum + e.quantity, 0);
  const totalCostBasis = entries.reduce((sum, e) => sum + e.quantity * e.purchasePrice, 0);
  const weightedAveragePrice = quantity > 0 ? totalCostBasis / quantity : 0;
  const currentValue = quantity * currentPrice;
  const unrealizedGainLoss = currentValue - totalCostBasis;
  const unrealizedGainLossPercent = totalCostBasis > 0 ? (unrealizedGainLoss / totalCostBasis) * 100 : 0;

  // Find period covered
  let periodStart: string | undefined;
  let periodEnd: string | undefined;

  if (entries.length > 0) {
    const timestamps = entries.map(e => new Date(e.purchaseTimestamp).getTime());
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    
    periodStart = new Date(minTime).toISOString();
    periodEnd = new Date(maxTime).toISOString();
  }

  // Create display description
  const sign = unrealizedGainLoss >= 0 ? '+' : '';
  const changeDescription = `${sign}${unrealizedGainLoss.toFixed(2)} USDC (${sign}${unrealizedGainLossPercent.toFixed(2)}%)`;

  return {
    quantity,
    weightedAveragePrice,
    totalCostBasis,
    currentPrice,
    currentValue,
    unrealizedGainLoss,
    unrealizedGainLossPercent,
    periodStart,
    periodEnd,
    changeDescription,
  };
}

/**
 * Helper to check if metrics represent a loss
 */
export function isLoss(metrics: YieldMetrics): boolean {
  return metrics.unrealizedGainLoss < 0;
}

/**
 * Helper to check if metrics represent a gain
 */
export function isGain(metrics: YieldMetrics): boolean {
  return metrics.unrealizedGainLoss > 0;
}

/**
 * Helper to check if there's any position
 */
export function hasPosition(metrics: YieldMetrics): boolean {
  return metrics.quantity > 0;
}
