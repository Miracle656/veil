import { forwardRef, useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';

import { useNetwork } from '../hooks/useNetwork';
import { useTheme } from '../hooks/useTheme';
import { explorerTxUrl, openExternalUrl } from '../lib/about';
import type { ThemeColors } from '../lib/theme';
import type { TxRecord } from '../lib/activityFeed';

/** A history transaction — mirrors the web wallet's `TxRecord` (components/TxDetailSheet.tsx). */
export type { TxRecord };

const TITLES: Record<TxRecord['type'], string> = {
  sent: 'Sent',
  received: 'Received',
  swapped: 'Swapped',
};

function shorten(value: string): string {
  if (value.includes('*') || value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

type TxDetailSheetProps = { tx: TxRecord | null };

/**
 * Reusable transaction detail bottom sheet, opened from a history feed. Uses a
 * @gorhom `BottomSheetModal`; the parent holds a ref and calls `present()`.
 * Requires `BottomSheetModalProvider` + `GestureHandlerRootView` at the root
 * (wired in `app/_layout.tsx`).
 */
export const TxDetailSheet = forwardRef<BottomSheetModal, TxDetailSheetProps>(
  function TxDetailSheet({ tx }, ref) {
    const { colors } = useTheme();
    const { network } = useNetwork();
    const styles = useMemo(() => createStyles(colors), [colors]);

    // Resolved against the *active* network: the app is dual-network at
    // runtime, so hardcoding a segment would send half the links to a page
    // reporting the transaction does not exist.
    const explorerUrl = useMemo(() => explorerTxUrl(tx?.hash, network), [tx?.hash, network]);
    const openExplorer = useCallback(() => {
      if (explorerUrl) void openExternalUrl(explorerUrl);
    }, [explorerUrl]);

    return (
      <BottomSheetModal
        ref={ref}
        backgroundStyle={styles.sheetBg}
        handleIndicatorStyle={styles.handleIndicator}
        backdropComponent={(props: BottomSheetBackdropProps) => (
          <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} />
        )}
      >
        <BottomSheetView style={styles.content}>
          {tx && (
            <>
              <Text style={styles.kind}>{TITLES[tx.type]}</Text>
              <Text style={styles.amount}>
                {tx.amount} {tx.asset}
              </Text>
              {tx.type === 'swapped' && tx.destAmount ? (
                <Text style={styles.swapTo}>
                  → {tx.destAmount} {tx.destAsset}
                </Text>
              ) : null}

              <View style={styles.rows}>
                <Row label="Counterparty" value={shorten(tx.counterparty)} mono styles={styles} />
                <Row
                  label="When"
                  value={new Date(tx.timestamp * 1000).toLocaleString()}
                  styles={styles}
                />
                {tx.memo ? <Row label="Memo" value={tx.memo} styles={styles} /> : null}
                {tx.hash ? (
                  <Row label="Tx hash" value={shorten(tx.hash)} mono styles={styles} />
                ) : null}
              </View>

              {explorerUrl ? (
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel="View this transaction on stellar.expert"
                  onPress={openExplorer}
                  style={styles.explorerLink}
                >
                  <Text style={styles.explorerLinkText}>View on explorer</Text>
                </Pressable>
              ) : null}
            </>
          )}
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

type Styles = ReturnType<typeof createStyles>;

function Row({
  label,
  value,
  mono,
  styles,
}: {
  label: string;
  value: string;
  mono?: boolean;
  styles: Styles;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.mono]}>{value}</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    sheetBg: {
      backgroundColor: colors.background,
    },
    handleIndicator: {
      backgroundColor: colors.textFaint,
    },
    content: {
      paddingHorizontal: 20,
      paddingBottom: 32,
      gap: 6,
    },
    kind: {
      color: colors.textFaint,
      fontSize: 12,
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    amount: {
      color: colors.textStrong,
      fontSize: 26,
      fontWeight: '700',
    },
    swapTo: {
      color: colors.accentText,
      fontSize: 15,
    },
    rows: {
      marginTop: 12,
      gap: 10,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: 16,
    },
    rowLabel: {
      color: colors.textFaint,
      fontSize: 13,
    },
    rowValue: {
      color: colors.textPrimary,
      fontSize: 13,
      flexShrink: 1,
      textAlign: 'right',
    },
    mono: {
      fontFamily: 'monospace',
    },
    explorerLink: {
      marginTop: 18,
      paddingVertical: 12,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.textFaint,
      alignItems: 'center',
    },
    explorerLinkText: {
      color: colors.accentText,
      fontSize: 14,
      fontWeight: '600',
    },
  });
