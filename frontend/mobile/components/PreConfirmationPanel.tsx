import React, { useMemo } from 'react';
import { StyleSheet, Text, View, ScrollView } from 'react-native';
import type { ThemeColors } from '../lib/theme';

export interface PreConfirmationData {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  amountOut: number;
  rate: number;
  priceImpactPct: number;
  /** null when the order book could not be read — not the same as zero. */
  spreadPct: number | null;
  /** null when the spread is unknown, so no total can honestly be given. */
  totalImpactPct: number | null;
  /** Why a figure is missing, shown verbatim when one is. */
  disclosure?: string | null;
  bestBid?: number;
  bestAsk?: number;
  sellbackAmount?: number;
  spreadLossPct?: number;
  roundTripImpactPct?: number;
}

interface Props {
  data: PreConfirmationData;
  colors: ThemeColors;
}

export function PreConfirmationPanel({ data, colors }: Props) {
  const styles = useMemo(() => createStyles(colors), [colors]);

  const formatNumber = (n: number, decimals: number = 4) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });

  // An unknown total is its own state. It must not fall through to the green
  // "ok" branch, which is how a figure nobody measured ends up looking
  // confirmed (#732).
  const impactStatus =
    data.totalImpactPct === null
      ? 'unknown'
      : data.totalImpactPct > 5
        ? 'error'
        : data.totalImpactPct > 2
          ? 'warning'
          : 'ok';

  const impactColor =
    impactStatus === 'error'
      ? '#FF3B30'
      : impactStatus === 'warning'
        ? '#FF9500'
        : impactStatus === 'unknown'
          ? colors.textSecondary
          : '#34C759';

  return (
    <ScrollView style={styles.container} scrollEnabled={false}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Trade Summary</Text>
        <View style={styles.row}>
          <Text style={styles.label}>You pay</Text>
          <Text style={styles.value}>
            {formatNumber(data.amountIn, 7)} {data.tokenIn}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>You receive</Text>
          <Text style={styles.value}>
            {formatNumber(data.amountOut, 7)} {data.tokenOut}
          </Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Exchange rate</Text>
          <Text style={styles.value}>1 {data.tokenIn} = {formatNumber(data.rate, 4)} {data.tokenOut}</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Price Impact</Text>
        <View style={styles.row}>
          <Text style={styles.label}>Soroswap impact</Text>
          <Text style={styles.value}>{formatNumber(data.priceImpactPct, 2)}%</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.label}>Bid-ask spread</Text>
          <Text style={data.spreadPct === null ? styles.valueUnknown : styles.value}>
            {data.spreadPct === null ? 'Not measured' : `${formatNumber(data.spreadPct, 2)}%`}
          </Text>
        </View>
        {data.bestBid && data.bestAsk && (
          <View style={styles.row}>
            <Text style={styles.label}>Book depth</Text>
            <Text style={styles.value}>
              Bid {formatNumber(data.bestBid, 4)} / Ask {formatNumber(data.bestAsk, 4)}
            </Text>
          </View>
        )}
        <View style={[styles.row, styles.totalImpactRow, { borderColor: impactColor }]}>
          <Text style={styles.label}>Total impact</Text>
          <Text style={[styles.value, { color: impactColor, fontWeight: '600' }]}>
            {data.totalImpactPct === null ? 'Unavailable' : `${formatNumber(data.totalImpactPct, 2)}%`}
          </Text>
        </View>
        {data.disclosure ? <Text style={styles.disclosure}>{data.disclosure}</Text> : null}
      </View>

      {data.sellbackAmount !== undefined && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Round-Trip Cost (if sold immediately)</Text>
          <View style={styles.row}>
            <Text style={styles.label}>You&apos;d get back</Text>
            <Text style={styles.value}>
              {formatNumber(data.sellbackAmount, 7)} {data.tokenIn}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Spread loss</Text>
            <Text style={styles.valueWarning}>
              -{formatNumber(data.spreadLossPct ?? 0, 2)}%
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Round-trip impact</Text>
            <Text style={styles.valueWarning}>
              {formatNumber(data.roundTripImpactPct ?? 0, 2)}%
            </Text>
          </View>
          <Text style={styles.disclaimer}>
            This shows what you&apos;d receive if you sold the output immediately at the current market price.
            Actual results depend on market conditions at execution time.
          </Text>
        </View>
      )}

      {data.totalImpactPct !== null && data.totalImpactPct > 5 && (
        <View style={[styles.section, styles.warningSection]}>
          <Text style={styles.warningTitle}>⚠️ High Impact</Text>
          <Text style={styles.warningText}>
            This order would result in a {formatNumber(data.totalImpactPct, 2)}% price impact, exceeding the 5% threshold.
          </Text>
          <Text style={styles.warningSubtext}>
            Consider reducing the order size or waiting for better liquidity.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      marginBottom: 16,
    },
    section: {
      marginBottom: 20,
      paddingBottom: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.textStrong,
      marginBottom: 12,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
      paddingVertical: 4,
    },
    label: {
      fontSize: 13,
      color: colors.textSecondary,
    },
    value: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.textPrimary,
    },
    valueUnknown: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.textSecondary,
      fontStyle: 'italic',
    },
    disclosure: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 8,
      lineHeight: 17,
    },
    valueWarning: {
      fontSize: 13,
      fontWeight: '500',
      color: '#FF3B30',
    },
    totalImpactRow: {
      marginTop: 8,
      paddingVertical: 8,
      paddingHorizontal: 8,
      borderRadius: 6,
      borderWidth: 1,
      borderLeftWidth: 3,
    },
    disclaimer: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 12,
      fontStyle: 'italic',
    },
    warningSection: {
      backgroundColor: 'rgba(255, 59, 48, 0.08)',
      borderBottomWidth: 0,
      borderRadius: 8,
      padding: 12,
    },
    warningTitle: {
      fontSize: 13,
      fontWeight: '600',
      color: '#FF3B30',
      marginBottom: 8,
    },
    warningText: {
      fontSize: 12,
      color: colors.textPrimary,
      marginBottom: 6,
      lineHeight: 18,
    },
    warningSubtext: {
      fontSize: 11,
      color: colors.textSecondary,
      lineHeight: 16,
    },
  });
}
