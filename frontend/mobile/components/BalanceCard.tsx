import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Horizon } from '@stellar/stellar-sdk';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { getNetwork } from '../lib/network';
import { getWalletAddress } from '../lib/walletStore';
import { fetchPrice, formatUsd, usdValue } from '../lib/fetchPrice';

/** A 404 from Horizon means the account exists in-wallet but isn't funded yet. */
function isAccountNotFound(err: unknown): boolean {
  const e = err as { name?: string; response?: { status?: number } };
  return e?.name === 'NotFoundError' || e?.response?.status === 404;
}

async function fetchNativeBalance(publicKey: string): Promise<string> {
  const server = new Horizon.Server(getNetwork().horizonUrl);
  try {
    const account = await server.loadAccount(publicKey);
    const native = account.balances.find((b) => b.asset_type === 'native');
    return native ? native.balance : '0';
  } catch (err) {
    if (isAccountNotFound(err)) return '0'; // unfunded → zero, not an error
    throw err;
  }
}

type State =
  | { status: 'loading' }
  | { status: 'no-wallet' }
  | { status: 'error' }
  | { status: 'ready'; balance: string; usd: number | null };

export type BalanceCardProps = {
  /** If provided, overrides the internal balance loading logic. */
  balance?: string;
  /** If provided, overrides the internal price loading logic. */
  usd?: number | null;
  /** If provided, overrides the internal loading status. */
  loading?: boolean;
  /** If provided, overrides the internal error status. */
  error?: boolean;
};

/**
 * The dashboard's primary balance — native XLM plus its fiat value from the
 * Lens oracle. The native port of the web wallet's balance query
 * (`dashboard/page.tsx`) + `fetchPrice`. The balance is authoritative and
 * always shown once loaded; the fiat line degrades to an em dash whenever the
 * price feed is unavailable, so a slow or gated oracle never blocks the card.
 */
export function BalanceCard({ balance: propBalance, usd: propUsd, loading: propLoading, error: propError }: BalanceCardProps = {}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    if (propBalance !== undefined) return;
    setState({ status: 'loading' });
    try {
      const address = await getWalletAddress();
      if (!address) {
        setState({ status: 'no-wallet' });
        return;
      }
      // Balance is load-bearing; price is best-effort and settles independently.
      const [balance, price] = await Promise.all([
        fetchNativeBalance(address),
        fetchPrice('XLM', null),
      ]);
      setState({ status: 'ready', balance, usd: usdValue(balance, price) });
    } catch {
      setState({ status: 'error' });
    }
  }, [propBalance]);

  useEffect(() => {
    void load();
  }, [load]);

  // Determine active status and fields based on props vs state
  const isControlled = propBalance !== undefined;
  const isLoading = isControlled ? !!propLoading : state.status === 'loading';
  const isError = isControlled ? !!propError : state.status === 'error';
  const showBalance = isControlled ? propBalance : (state.status === 'ready' ? state.balance : null);
  const showUsd = isControlled ? (propUsd ?? null) : (state.status === 'ready' ? state.usd : null);

  return (
    <View style={styles.card}>
      <Text style={styles.label}>Total balance</Text>

      {isLoading && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}

      {!isLoading && !isError && showBalance === null && (
        <Text style={styles.muted}>No wallet yet — create or import one to see your balance.</Text>
      )}

      {isError && (
        <Text style={styles.error}>Couldn’t load your balance. Pull to refresh.</Text>
      )}

      {!isLoading && !isError && showBalance !== null && (
        <>
          <View style={styles.amountRow}>
            <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit>
              {showBalance}
            </Text>
            <Text style={styles.unit}>XLM</Text>
          </View>
          <Text style={styles.usd}>{formatUsd(showUsd)}</Text>
        </>
      )}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 24,
      gap: 6,
    },
    label: {
      color: colors.textFaint,
      fontSize: 12,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    center: {
      paddingVertical: 12,
      alignItems: 'flex-start',
    },
    amountRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 8,
    },
    amount: {
      color: colors.textStrong,
      fontSize: 40,
      fontWeight: '700',
      flexShrink: 1,
    },
    unit: {
      color: colors.textSecondary,
      fontSize: 18,
      fontWeight: '600',
    },
    usd: {
      color: colors.textMuted,
      fontSize: 16,
    },
    muted: {
      color: colors.textSecondary,
      fontSize: 14,
    },
    error: {
      color: colors.danger,
      fontSize: 14,
    },
  });
