/**
 * Cost Basis Tracker Integration
 * 
 * Integrates cost basis tracking with activity feeds, swaps, and payments.
 * Fetches prices at transaction time and records purchase history.
 */

import { CostBasisStore, CostEntry, type YieldMetrics } from './costBasis';
import { calculateYieldMetrics } from './costBasis';
import type { WalletAsset } from '@/lib/dashboard';

export interface TrackedAsset extends WalletAsset {
  /** Cost basis metrics for this asset */
  yieldMetrics?: YieldMetrics;
  /** Weighted average purchase price (USDC per unit) */
  weightedAveragePrice?: number;
  /** Total amount invested in this asset */
  costBasis?: number;
  /** Unrealized gain/loss in USDC */
  gainLoss?: number;
  /** Unrealized gain/loss as percentage */
  gainLossPercent?: number;
}

/**
 * Record a purchase when user acquires an asset
 * Used after swap completion, payment received, etc.
 */
export async function recordPurchase(
  network: string,
  walletAddress: string,
  assetCode: string,
  assetIssuer: string,
  quantity: number,
  pricePerUnitUsdc: number,
  purchaseType: 'swap' | 'payment_received' | 'airdrop' | 'manual' | 'other',
  transactionHash: string,
  memo?: string,
): Promise<void> {
  const store = new CostBasisStore(network, walletAddress);
  
  const entry: CostEntry = {
    quantity,
    purchasePrice: pricePerUnitUsdc,
    purchaseTimestamp: new Date().toISOString(),
    transactionHash,
    purchaseType,
    memo,
  };

  store.addEntry(assetCode, assetIssuer, entry);
}

/**
 * Record a sale when user disposes of an asset
 * Used when selling part/all of a position
 */
export async function recordSale(
  network: string,
  walletAddress: string,
  assetCode: string,
  assetIssuer: string,
  quantitySold: number,
  salePriceUsdc: number,
  transactionHash: string,
): Promise<{ realizedGainLoss: number; costBasis: number }> {
  const store = new CostBasisStore(network, walletAddress);
  
  const soldEntries = store.recordSale(assetCode, assetIssuer, quantitySold);
  const realizedGainLoss = store.calculateRealizedGainLoss(
    assetCode,
    assetIssuer,
    salePriceUsdc,
    quantitySold,
  );

  const costBasisOfSold = soldEntries.reduce(
    (sum, entry) => sum + entry.quantity * entry.purchasePrice,
    0,
  );

  return { realizedGainLoss, costBasis: costBasisOfSold };
}

/**
 * Enhance wallet assets with cost basis and yield data
 */
export function enhanceAssetsWithYield(
  assets: WalletAsset[],
  network: string,
  walletAddress: string,
  currentPrices: Record<string, number | null>,
): TrackedAsset[] {
  const store = new CostBasisStore(network, walletAddress);

  return assets.map((asset) => {
    const entries = store.getEntries(asset.code, asset.issuer);
    const currentPrice = currentPrices[`${asset.code}:${asset.issuer}`] ?? null;

    if (!currentPrice || entries.length === 0) {
      // No cost basis or price data - return asset as-is
      return asset as TrackedAsset;
    }

    const yieldMetrics = calculateYieldMetrics(entries, currentPrice);

    return {
      ...asset,
      yieldMetrics,
      weightedAveragePrice: yieldMetrics.weightedAveragePrice,
      costBasis: yieldMetrics.totalCostBasis,
      gainLoss: yieldMetrics.unrealizedGainLoss,
      gainLossPercent: yieldMetrics.unrealizedGainLossPercent,
    };
  });
}

/**
 * Get yield summary for a single asset
 */
export function getAssetYield(
  network: string,
  walletAddress: string,
  assetCode: string,
  assetIssuer: string,
  currentPriceUsdc: number | null,
): YieldMetrics | null {
  if (!currentPriceUsdc) return null;

  const store = new CostBasisStore(network, walletAddress);
  const entries = store.getEntries(assetCode, assetIssuer);

  if (entries.length === 0) return null;

  return calculateYieldMetrics(entries, currentPriceUsdc);
}

/**
 * Get total portfolio cost basis
 */
export function getPortfolioCostBasis(
  network: string,
  walletAddress: string,
): number {
  const store = new CostBasisStore(network, walletAddress);
  const assets = store.getAllAssets();

  return assets.reduce((total, asset) => {
    return total + store.getTotalCostBasis(asset.code, asset.issuer);
  }, 0);
}

/**
 * Get total unrealized gains/losses
 */
export function getPortfolioGainLoss(
  network: string,
  walletAddress: string,
  currentPortfolioValue: number,
): number {
  const costBasis = getPortfolioCostBasis(network, walletAddress);
  return currentPortfolioValue - costBasis;
}

/**
 * Format gain/loss for display
 */
export function formatGainLoss(
  gainLoss: number,
  percent: number,
  decimals: number = 2,
): string {
  const sign = gainLoss >= 0 ? '+' : '';
  const gainLossStr = gainLoss.toFixed(decimals);
  const percentStr = percent.toFixed(2);
  return `${sign}${gainLossStr} USDC (${sign}${percentStr}%)`;
}

/**
 * Get color for displaying gain/loss
 */
export function getGainLossColor(
  gainLoss: number,
): 'text-green-600' | 'text-red-600' | 'text-gray-600' {
  if (gainLoss > 0) return 'text-green-600';
  if (gainLoss < 0) return 'text-red-600';
  return 'text-gray-600';
}

/**
 * Get CSS class for displaying gain/loss
 */
export function getGainLossClass(gainLoss: number): string {
  return `${getGainLossColor(gainLoss)} font-semibold`;
}

/**
 * Export cost basis data for backup
 */
export function exportCostBasisData(
  network: string,
  walletAddress: string,
): string {
  const store = new CostBasisStore(network, walletAddress);
  const data = store.export();
  return JSON.stringify(data, null, 2);
}

/**
 * Import cost basis data from backup
 */
export function importCostBasisData(
  network: string,
  walletAddress: string,
  dataJson: string,
): void {
  try {
    const data = JSON.parse(dataJson);
    const store = new CostBasisStore(network, walletAddress);
    store.import(data);
  } catch (error) {
    console.error('Failed to import cost basis data:', error);
    throw new Error('Invalid cost basis backup file');
  }
}

/**
 * Clear all cost basis data for an account
 */
export function clearCostBasisData(
  network: string,
  walletAddress: string,
): void {
  const store = new CostBasisStore(network, walletAddress);
  store.clear();
}

/**
 * Track incoming transfer (payment received, airdrop, etc.)
 */
export async function trackIncomingTransfer(
  network: string,
  walletAddress: string,
  assetCode: string,
  assetIssuer: string,
  quantity: number,
  currentPriceUsdc: number | null,
  transactionHash: string,
  transferType: 'payment_received' | 'airdrop' | 'other',
  memo?: string,
): Promise<void> {
  // Use current price if available, otherwise use 0 (for tracking but not calculating basis)
  const pricePerUnit = currentPriceUsdc ?? 0;

  if (pricePerUnit === 0) {
    console.warn(
      `No price available for ${assetCode}/${assetIssuer} - tracking transfer without cost basis`,
    );
  }

  await recordPurchase(
    network,
    walletAddress,
    assetCode,
    assetIssuer,
    quantity,
    pricePerUnit,
    transferType,
    transactionHash,
    memo,
  );
}

/**
 * Track activity events and automatically record cost basis for relevant transactions
 */
export async function trackActivityEvent(
  event: {
    type: 'sent' | 'received' | 'swapped';
    amount: string;
    asset: string;
    destAmount?: string;
    destAsset?: string;
    hash: string;
    timestamp: number;
  },
  network: string,
  walletAddress: string,
  assetIssuerMap: Record<string, string>, // Maps asset code to issuer
  currentPrices: Record<string, number | null>,
): Promise<void> {
  // Only track purchases (received, swapped destination)
  if (event.type === 'sent') {
    // Could track sales here later for realized gain/loss calculations
    return;
  }

  const now = new Date();

  if (event.type === 'received') {
    const issuer = assetIssuerMap[event.asset] || '';
    const price = currentPrices[`${event.asset}:${issuer}`];

    await trackIncomingTransfer(
      network,
      walletAddress,
      event.asset,
      issuer,
      parseFloat(event.amount),
      price ?? null,
      event.hash,
      'payment_received',
      `Received ${event.amount} ${event.asset}`,
    );
  }

  if (event.type === 'swapped' && event.destAsset && event.destAmount) {
    const issuer = assetIssuerMap[event.destAsset] || '';
    const price = currentPrices[`${event.destAsset}:${issuer}`];

    await recordPurchase(
      network,
      walletAddress,
      event.destAsset,
      issuer,
      parseFloat(event.destAmount),
      price ?? 0,
      'swap',
      event.hash,
      `Swapped ${event.amount} ${event.asset} for ${event.destAmount} ${event.destAsset}`,
    );
  }
}
