import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ThemeToggle } from '../components/ThemeToggle';
import { useTheme } from '../hooks/useTheme';
import { getSoroswapQuote, type SwapQuote } from '../lib/soroswap';
import type { ThemeColors } from '../lib/theme';

const DEBOUNCE_MS = 600;
const NATIVE_XLM_CONTRACT = process.env['EXPO_PUBLIC_XLM_CONTRACT_ID']?.trim() || '';
const DEFAULT_TOKEN_OUT = process.env['EXPO_PUBLIC_USDC_CONTRACT_ID']?.trim() || '';
const FEE_PAYER_ADDRESS = process.env['EXPO_PUBLIC_FEE_PAYER_ADDRESS']?.trim() || '';

export default function SwapScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [amountIn, setAmountIn] = useState('');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const parsed = parseFloat(amountIn);
    if (!amountIn || isNaN(parsed) || parsed <= 0) {
      setQuote(null);
      setError(null);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setIsFetching(true);
      setError(null);
      const amountInStroops = Math.round(parsed * 1e7).toString();
      const result = await getSoroswapQuote({
        tokenIn: NATIVE_XLM_CONTRACT,
        tokenOut: DEFAULT_TOKEN_OUT,
        amountIn: amountInStroops,
        slippageBps: 50,
        feePayerAddress: FEE_PAYER_ADDRESS,
      });
      if (result) {
        setQuote(result);
      } else {
        setQuote(null);
        setError('No live quote available for this pair.');
      }
      setIsFetching(false);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [amountIn]);

  const rate =
    quote && amountIn ? (Number(quote.amountOut) / 1e7 / parseFloat(amountIn)).toFixed(4) : null;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Swap</Text>
        <ThemeToggle />
      </View>
      <Text style={styles.subtitle}>XLM → USDC</Text>

      <TextInput
        style={styles.input}
        placeholder="Amount (XLM)"
        placeholderTextColor={colors.textFaint}
        value={amountIn}
        onChangeText={setAmountIn}
        keyboardType="decimal-pad"
      />

      {isFetching && <ActivityIndicator color={colors.accent} style={styles.spinner} />}

      {quote && !isFetching && (
        <View style={styles.card}>
          <Row
            styles={styles}
            label="You receive"
            value={`${(Number(quote.amountOut) / 1e7).toFixed(7)} USDC`}
          />
          {rate && <Row styles={styles} label="Rate" value={`1 XLM ≈ ${rate} USDC`} />}
          <Row
            styles={styles}
            label="Price impact"
            value={quote.priceImpact < 0.005 ? '< 0.01%' : `${(quote.priceImpact * 100).toFixed(2)}%`}
          />
          <Row styles={styles} label="Route" value={quote.protocols.join(' · ')} />
        </View>
      )}

      {error && !isFetching && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
  );
}

function Row({
  styles,
  label,
  value,
}: {
  styles: SwapStyles;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

type SwapStyles = ReturnType<typeof createStyles>;

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flexGrow: 1,
      backgroundColor: colors.background,
      padding: 24,
      gap: 16,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      color: colors.textStrong,
      fontSize: 28,
      fontWeight: '700',
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 15,
    },
    input: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 14,
      color: colors.textPrimary,
      fontSize: 16,
      borderWidth: 1,
      borderColor: colors.border,
    },
    spinner: {
      marginTop: 8,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 14,
      gap: 8,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    rowLabel: {
      color: colors.textMuted,
      fontSize: 13,
    },
    rowValue: {
      color: colors.textPrimary,
      fontSize: 13,
      fontWeight: '600',
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      backgroundColor: colors.dangerSurface,
      borderRadius: 8,
      padding: 10,
    },
  });
