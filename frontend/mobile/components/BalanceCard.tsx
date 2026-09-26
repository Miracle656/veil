import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../hooks/useTheme';
import { useCurrency } from '../hooks/useCurrency';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { CURRENCY_CODES } from '../lib/currency';
import { fetchAccountReserve } from '../lib/accountReserve';
import { getWalletAddress } from '../lib/walletStore';
import { fetchPrice, usdValue } from '../lib/fetchPrice';
import { ChevronDownIcon, EyeIcon, EyeOffIcon } from './icons';

/** Trim a raw balance string to at most 2 decimals for the sub-line. */
function trimAmount(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return raw;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type State =
  | { status: 'loading' }
  | { status: 'no-wallet' }
  | { status: 'error' }
  | { status: 'ready'; balance: string; usd: number | null; reservedXlm: number; subentries: number };

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
 * The dashboard's fiat-facing balance hero.
 *
 * Matches the redesign artboard: a bare block (no boxed card) with an Anton
 * uppercase label, the balance as a large tabular-nums figure in the user's
 * chosen local currency, and the underlying crypto amount in Inconsolata mono
 * beneath it. The fiat value derives from the native XLM balance × the Lens
 * oracle price (`fetchPrice`) and is converted to local currency by
 * `useCurrency`; both degrade gracefully — an unpriced balance falls back to the
 * raw crypto amount as the hero, so a slow oracle never blanks the screen.
 *
 * Two global-preference controls live here because every screen shares them: the
 * eye toggles "hide amounts" (`useHiddenAmounts`) and the chip cycles the
 * display currency (`useCurrency`).
 */
export function BalanceCard({ balance: propBalance, usd: propUsd, loading: propLoading, error: propError }: BalanceCardProps = {}) {
  const { colors } = useTheme();
  const { currency, select, format } = useCurrency();
  const { hidden, toggle: toggleHidden, mask } = useHiddenAmounts();
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
      const [account, price] = await Promise.all([
        fetchAccountReserve(address),
        fetchPrice('XLM', null),
      ]);
      setState({
        status: 'ready',
        balance: account.balance,
        usd: usdValue(account.balance, price),
        reservedXlm: account.reservedXlm,
        subentries: account.subentries,
      });
    } catch {
      setState({ status: 'error' });
    }
  }, [propBalance]);

  useEffect(() => {
    void load();
  }, [load]);

  const cycleCurrency = useCallback(() => {
    const i = CURRENCY_CODES.indexOf(currency);
    select(CURRENCY_CODES[(i + 1) % CURRENCY_CODES.length]);
  }, [currency, select]);

  const isControlled = propBalance !== undefined;
  const isLoading = isControlled ? !!propLoading : state.status === 'loading';
  const isError = isControlled ? !!propError : state.status === 'error';
  const showBalance = isControlled ? propBalance : (state.status === 'ready' ? state.balance : null);
  const showUsd = isControlled ? (propUsd ?? null) : (state.status === 'ready' ? state.usd : null);

  const hasFiat = showUsd !== null;
  const heroText = hasFiat ? format(showUsd) : (showBalance !== null ? `${trimAmount(showBalance)} XLM` : '0');

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.label}>Total balance</Text>
        <View style={styles.controls}>
          <Pressable
            onPress={cycleCurrency}
            accessibilityRole="button"
            accessibilityLabel={`Display currency: ${currency}. Tap to change.`}
            hitSlop={8}
            style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
          >
            <Text style={styles.chipText}>{currency}</Text>
            <ChevronDownIcon size={12} color={colors.textSecondary} />
          </Pressable>
          <Pressable
            onPress={toggleHidden}
            accessibilityRole="switch"
            accessibilityState={{ checked: hidden }}
            accessibilityLabel={hidden ? 'Show amounts' : 'Hide amounts'}
            hitSlop={8}
            style={({ pressed }) => [styles.eyeButton, pressed && styles.pressed]}
          >
            {hidden ? <EyeOffIcon size={18} color={colors.textSecondary} /> : <EyeIcon size={18} color={colors.textSecondary} />}
          </Pressable>
        </View>
      </View>

      {isLoading && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}

      {!isLoading && !isError && showBalance === null && (
        <Text style={styles.muted}>No wallet yet — create or import one to see your balance.</Text>
      )}

      {isError && <Text style={styles.error}>Couldn’t load your balance. Pull to refresh.</Text>}

      {!isLoading && !isError && showBalance !== null && (
        <>
          <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit>
            {mask(heroText)}
          </Text>
          {hasFiat && (
            <Text style={styles.sub}>{hidden ? mask('') : `${trimAmount(showBalance)} XLM`}</Text>
          )}
          {!hidden && state.status === 'ready' && (
            <Text style={styles.reserve}>
              {trimAmount(String(state.reservedXlm))} XLM reserved by the network ({state.subentries}{' '}
              {state.subentries === 1 ? 'subentry' : 'subentries'}). Refundable when removed.
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      paddingVertical: 14,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    controls: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 11,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    chipText: {
      color: colors.textSecondary,
      fontFamily: fontFamily.address,
      fontSize: 12.5,
    },
    eyeButton: {
      width: 34,
      height: 34,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    pressed: {
      opacity: 0.6,
    },
    label: {
      color: colors.label,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    center: {
      paddingVertical: 16,
      alignItems: 'flex-start',
    },
    amount: {
      color: colors.textStrong,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 44,
      letterSpacing: -0.5,
      marginTop: 8,
      fontVariant: ['tabular-nums'],
    },
    sub: {
      color: colors.textMuted,
      fontFamily: fontFamily.address,
      fontSize: 14,
      marginTop: 10,
    },
    reserve: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 12,
      marginTop: 6,
    },
    muted: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14,
      marginTop: 10,
    },
    error: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 14,
      marginTop: 10,
    },
  });
