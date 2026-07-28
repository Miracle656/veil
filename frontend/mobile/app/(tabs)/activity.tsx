import { useCallback, useRef, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';

import { TxPreviewCard, type TxPreview } from '../../components/TxPreviewCard';
import { TxDetailSheet, type TxRecord } from '../../components/TxDetailSheet';

const NOW = Math.floor(Date.now() / 1000);

const PREVIEW: TxPreview = {
  action: 'Send',
  amount: '25',
  asset: 'USDC',
  recipient: 'GA3DHM4WL2VXPHR7NQKPZ7XK9FQJ2ULTQ6ZT4W2M5N6Q7RSTUVWXK9FQ',
  feeXlm: '0.00001',
};

const FEED: TxRecord[] = [
  {
    id: '1',
    type: 'received',
    amount: '50',
    asset: 'USDC',
    counterparty: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    timestamp: NOW - 3600,
    hash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  },
  {
    id: '2',
    type: 'sent',
    amount: '10',
    asset: 'XLM',
    counterparty: 'ada*veil.money',
    timestamp: NOW - 86400,
    memo: 'lunch',
  },
  {
    id: '3',
    type: 'swapped',
    amount: '100',
    asset: 'XLM',
    destAmount: '9.82',
    destAsset: 'USDC',
    counterparty: 'Soroswap',
    timestamp: NOW - 172800,
  },
];

const LABELS: Record<TxRecord['type'], string> = {
  sent: 'Sent',
  received: 'Received',
  swapped: 'Swapped',
};

/**
 * Activity gallery (`/activity`) — renders the reusable transaction surfaces:
 * the confirm-step `TxPreviewCard`, and a feed whose items open the
 * `TxDetailSheet` bottom sheet on tap.
 */
export default function ActivityScreen() {
  const sheetRef = useRef<BottomSheetModal>(null);
  const [selected, setSelected] = useState<TxRecord | null>(null);

  const openDetail = useCallback((tx: TxRecord) => {
    setSelected(tx);
    sheetRef.current?.present();
  }, []);

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Activity</Text>

        <Text style={styles.section}>CONFIRM PREVIEW</Text>
        <TxPreviewCard preview={PREVIEW} />

        <Text style={styles.section}>RECENT</Text>
        {FEED.map((tx) => (
          <Pressable
            key={tx.id}
            accessibilityRole="button"
            onPress={() => openDetail(tx)}
            style={({ pressed }) => [styles.feedRow, pressed && styles.feedRowPressed]}
          >
            <View style={styles.feedText}>
              <Text style={styles.feedKind}>{LABELS[tx.type]}</Text>
              <Text style={styles.feedCounterparty}>{tx.counterparty}</Text>
            </View>
            <Text style={styles.feedAmount}>
              {tx.amount} {tx.asset}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <TxDetailSheet ref={sheetRef} tx={selected} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0F0F0F',
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 40,
    gap: 12,
  },
  title: {
    color: '#F6F7F8',
    fontSize: 28,
    fontWeight: '700',
  },
  section: {
    color: 'rgba(246,247,248,0.4)',
    fontSize: 12,
    letterSpacing: 1,
    marginTop: 12,
  },
  feedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  feedRowPressed: {
    opacity: 0.6,
  },
  feedText: {
    flex: 1,
  },
  feedKind: {
    color: '#F6F7F8',
    fontSize: 15,
    fontWeight: '500',
  },
  feedCounterparty: {
    color: 'rgba(246,247,248,0.4)',
    fontFamily: 'monospace',
    fontSize: 12,
    marginTop: 2,
  },
  feedAmount: {
    color: '#F6F7F8',
    fontSize: 15,
    fontWeight: '600',
  },
});
