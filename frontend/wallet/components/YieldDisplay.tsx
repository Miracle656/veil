'use client'

import { formatFiat } from '@/lib/currency'
import type { YieldMetrics } from '@/lib/costBasis'
import { isGain, isLoss } from '@/lib/costBasis'

export interface YieldDisplayProps {
  metrics: YieldMetrics | null | undefined;
  /** Show detailed breakdown or just summary */
  detailed?: boolean;
  /** Custom className for the container */
  className?: string;
  /** Show period covered dates */
  showPeriod?: boolean;
}

/**
 * Displays unrealized gain/loss information for an asset
 * Never shows "earnings" or "interest" - only "change in value"
 * Labels losses clearly as losses
 */
export function YieldDisplay({
  metrics,
  detailed = false,
  className = '',
  showPeriod = false,
}: YieldDisplayProps) {
  if (!metrics || metrics.quantity === 0) {
    return null;
  }

  const gainLossColor = isGain(metrics)
    ? 'text-green-600'
    : isLoss(metrics)
      ? 'text-red-600'
      : 'text-gray-600';

  const gainLossSign = metrics.unrealizedGainLoss >= 0 ? '+' : '';

  if (!detailed) {
    // Compact display
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <span className={`font-semibold ${gainLossColor}`}>
          {gainLossSign}
          {formatFiat(metrics.unrealizedGainLoss)}
        </span>
        <span className={`text-sm ${gainLossColor}`}>
          ({gainLossSign}
          {metrics.unrealizedGainLossPercent.toFixed(2)}%)
        </span>
      </div>
    );
  }

  // Detailed display with breakdown
  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      <div className="flex justify-between items-center">
        <span className="text-gray-600">Quantity held:</span>
        <span className="font-semibold">{metrics.quantity.toFixed(2)}</span>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-gray-600">Weighted average price:</span>
        <span className="font-semibold">{formatFiat(metrics.weightedAveragePrice)}/unit</span>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-gray-600">Total cost basis:</span>
        <span className="font-semibold">{formatFiat(metrics.totalCostBasis)}</span>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-gray-600">Current price:</span>
        <span className="font-semibold">{formatFiat(metrics.currentPrice)}/unit</span>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-gray-600">Current value:</span>
        <span className="font-semibold">{formatFiat(metrics.currentValue)}</span>
      </div>

      <div className="border-t border-gray-200 pt-3 flex justify-between items-center">
        <span className="text-gray-700 font-medium">Change in value:</span>
        <span className={`font-bold text-lg ${gainLossColor}`}>
          {gainLossSign}
          {formatFiat(metrics.unrealizedGainLoss)} ({gainLossSign}
          {metrics.unrealizedGainLossPercent.toFixed(2)}%)
        </span>
      </div>

      {showPeriod && metrics.periodStart && (
        <div className="text-xs text-gray-500 pt-2 border-t border-gray-100">
          <div>Earliest purchase: {new Date(metrics.periodStart).toLocaleDateString()}</div>
          {metrics.periodEnd && (
            <div>Latest purchase: {new Date(metrics.periodEnd).toLocaleDateString()}</div>
          )}
        </div>
      )}

      {/* Loss indicator */}
      {isLoss(metrics) && (
        <div className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">
          This asset is currently showing an unrealized loss. The price has decreased since purchase.
        </div>
      )}

      {/* Gain indicator */}
      {isGain(metrics) && (
        <div className="bg-green-50 border border-green-200 rounded px-3 py-2 text-sm text-green-700">
          This asset is currently showing an unrealized gain. The price has increased since purchase.
        </div>
      )}
    </div>
  );
}

/**
 * Simple inline yield badge for quick reference
 */
export function YieldBadge({ metrics }: { metrics: YieldMetrics | null | undefined }) {
  if (!metrics || metrics.quantity === 0) {
    return null;
  }

  const gainLossColor = isGain(metrics) ? 'bg-green-100 text-green-800' : 
                        isLoss(metrics) ? 'bg-red-100 text-red-800' : 
                        'bg-gray-100 text-gray-800';

  const gainLossSign = metrics.unrealizedGainLoss >= 0 ? '+' : '';

  return (
    <span className={`inline-block px-2 py-1 rounded text-sm font-semibold ${gainLossColor}`}>
      {gainLossSign}
      {formatFiat(metrics.unrealizedGainLoss)} ({gainLossSign}
      {metrics.unrealizedGainLossPercent.toFixed(2)}%)
    </span>
  );
}
