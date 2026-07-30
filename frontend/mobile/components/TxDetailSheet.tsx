import { forwardRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';

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
                <Row label="Counterparty" value={shorten(tx.counterparty)} mono />
                <Row label="When" value={new Date(tx.timestamp * 1000).toLocaleString()} />
                {tx.memo ? <Row label="Memo" value={tx.memo} /> : null}
                {tx.hash ? <Row label="Tx hash" value={shorten(tx.hash)} mono /> : null}
              </View>
            </>
          )}
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.mono]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheetBg: {
    backgroundColor: '#141418',
  },
  handleIndicator: {
    backgroundColor: 'rgba(246,247,248,0.3)',
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    gap: 6,
  },
  kind: {
    color: 'rgba(246,247,248,0.4)',
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  amount: {
    color: '#F6F7F8',
    fontSize: 26,
    fontWeight: '700',
  },
  swapTo: {
    color: '#FDDA24',
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
    color: 'rgba(246,247,248,0.4)',
    fontSize: 13,
  },
  rowValue: {
    color: '#F6F7F8',
    fontSize: 13,
    flexShrink: 1,
    textAlign: 'right',
  },
  mono: {
    fontFamily: 'monospace',
  },
});
