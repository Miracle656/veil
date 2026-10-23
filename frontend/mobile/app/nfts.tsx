/**
 * NFTs screen — the native counterpart of the web gallery
 * (`frontend/wallet/app/nfts/page.tsx`).
 *
 * Same data as web: `lib/nfts.ts` reads the same Wraith `/nfts/transfers` +
 * `/nfts/owners` endpoints with the same ownership reduction, so the same
 * wallet shows the same items on both platforms.
 *
 * States are visually distinct: a skeleton while loading, a dashed empty card
 * when the indexer answers with nothing, and a red error card (with a Retry
 * button) when the indexer is missing or unreachable. Image/metadata failures
 * degrade to a placeholder tile, never a crash.
 *
 * Read-only: nothing here signs, so the walletConnect signing path is untouched.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenScaffold } from '../components/ScreenScaffold';
import { useTheme } from '../hooks/useTheme';
import { errorMessage } from '../lib/errorMessage';
import {
  fetchWalletNFTs,
  formatTokenId,
  IndexerNotConfiguredError,
  truncateAddress,
  type NFTItem,
} from '../lib/nfts';
import type { ThemeColors } from '../lib/theme';
import { useNetwork } from '../hooks/useNetwork';
import { getWalletAddress } from '../lib/walletStore';
import { fontFamily } from '../theme/typography';

type State =
  | { kind: 'loading' }
  | { kind: 'no-wallet' }
  | { kind: 'unconfigured'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; items: NFTItem[] };

function NftImage({ item, size }: { item: NFTItem; size: 'grid' | 'detail' }) {
  const [failed, setFailed] = useState(false);
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (!item.image || failed) {
    return (
      <View style={size === 'grid' ? styles.tileFallback : styles.detailFallback} testID={`nft-placeholder-${item.id}`}>
        <Text style={styles.fallbackGlyph}>✦</Text>
        <Text style={styles.fallbackName} numberOfLines={2}>
          {item.name}
        </Text>
        {!item.image ? (
          <Text style={styles.fallbackHint}>No image published</Text>
        ) : null}
      </View>
    );
  }
  return (
    <Image
      source={{ uri: item.image }}
      style={size === 'grid' ? styles.tileImage : styles.detailImage}
      resizeMode="cover"
      onError={() => setFailed(true)}
      accessibilityLabel={item.name}
    />
  );
}

export default function NFTsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { networkName } = useNetwork();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<NFTItem | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const address = await getWalletAddress();
      if (!address) {
        setState({ kind: 'no-wallet' });
        return;
      }
      const items = await fetchWalletNFTs(address);
      setState({ kind: 'ready', items });
    } catch (err) {
      if (err instanceof IndexerNotConfiguredError) {
        setState({ kind: 'unconfigured', message: err.message });
      } else {
        setState({ kind: 'error', message: errorMessage(err) });
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, networkName]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const address = await getWalletAddress();
      if (!address) {
        setState({ kind: 'no-wallet' });
        return;
      }
      const items = await fetchWalletNFTs(address);
      setState({ kind: 'ready', items });
    } catch (err) {
      if (err instanceof IndexerNotConfiguredError) {
        setState({ kind: 'unconfigured', message: err.message });
      } else {
        setState({ kind: 'error', message: errorMessage(err) });
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  const renderBody = () => {
    if (state.kind === 'loading') {
      return (
        <View style={styles.center} testID="nft-loading-state">
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.muted}>Loading your NFTs…</Text>
        </View>
      );
    }
    if (state.kind === 'no-wallet') {
      return (
        <View style={styles.emptyCard} testID="nft-empty-state">
          <Text style={styles.emptyTitle}>No wallet yet</Text>
          <Text style={styles.muted}>Create or recover a wallet to see its NFTs here.</Text>
        </View>
      );
    }
    if (state.kind === 'unconfigured') {
      return (
        <View style={styles.errorCard} testID="nft-error-state">
          <Text style={styles.errorTitle}>No NFT indexer configured</Text>
          <Text style={styles.errorBody}>{state.message}</Text>
        </View>
      );
    }
    if (state.kind === 'error') {
      return (
        <View style={styles.errorCard} testID="nft-error-state">
          <Text style={styles.errorTitle}>Unable to fetch NFTs</Text>
          <Text style={styles.errorBody}>{state.message}</Text>
          <Pressable
            onPress={() => void load()}
            accessibilityRole="button"
            accessibilityLabel="Retry fetching NFTs"
            style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
          >
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </View>
      );
    }
    if (state.items.length === 0) {
      return (
        <View style={styles.emptyCard} testID="nft-empty-state">
          <Text style={styles.emptyTitle}>No CAP-46 NFTs found</Text>
          <Text style={styles.muted}>
            This wallet holds no CAP-46 non-fungible tokens on {networkName}.
          </Text>
          <Pressable
            onPress={() => void load()}
            accessibilityRole="button"
            accessibilityLabel="Refresh NFTs"
            style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
          >
            <Text style={styles.ghostLabel}>Refresh</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <FlatList
        data={state.items}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.grid}
        testID="nft-grid"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => setSelected(item)}
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.name}`}
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}
          >
            <View style={styles.tile}>
              <NftImage item={item} size="grid" />
              <View style={styles.tokenBadge}>
                <Text style={styles.tokenBadgeLabel}>{formatTokenId(item.tokenId)}</Text>
              </View>
            </View>
            <View style={styles.cardBody}>
              {item.collectionName ? (
                <Text style={styles.collection} numberOfLines={1}>
                  {item.collectionName}
                </Text>
              ) : null}
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.contract} numberOfLines={1}>
                {truncateAddress(item.contractId, 4, 4)}
              </Text>
            </View>
          </Pressable>
        )}
      />
    );
  };

  return (
    <ScreenScaffold
      eyebrow="CAP-46"
      title="NFTs"
      description="The CAP-46 tokens this wallet holds — the same items the web gallery shows."
      testID="nfts-screen"
    >
      <SafeAreaView edges={[]} style={styles.flex}>
        {renderBody()}
      </SafeAreaView>

      <Modal visible={selected !== null} animationType="slide" onRequestClose={() => setSelected(null)}>
        <SafeAreaView style={styles.modalRoot} edges={['top', 'bottom']}>
          <Pressable
            onPress={() => setSelected(null)}
            accessibilityRole="button"
            accessibilityLabel="Close NFT details"
            hitSlop={12}
            style={styles.closeRow}
          >
            <Text style={styles.closeLabel}>← Back</Text>
          </Pressable>
          {selected ? (
            <View style={styles.modalBody} testID="nft-detail-view">
              <NftImage item={selected} size="detail" />
              <Text style={styles.detailCollection}>{selected.collectionName ?? 'Soroban CAP-46 NFT'}</Text>
              <Text style={styles.detailTitle}>{selected.name}</Text>
              {selected.description ? <Text style={styles.detailDesc}>{selected.description}</Text> : null}
              <View style={styles.propsBox}>
                <View style={styles.propRow}>
                  <Text style={styles.propKey}>Token ID</Text>
                  <Text style={styles.propValue}>{String(selected.tokenId)}</Text>
                </View>
                <View style={styles.propRow}>
                  <Text style={styles.propKey}>Contract</Text>
                  <Text style={[styles.propValue, styles.mono]}>{truncateAddress(selected.contractId, 6, 6)}</Text>
                </View>
                <View style={styles.propRow}>
                  <Text style={styles.propKey}>Standard</Text>
                  <Text style={styles.propValue}>{selected.standard}</Text>
                </View>
              </View>
              {selected.attributes.length > 0 ? (
                <View style={styles.traits}>
                  {selected.attributes.map((attr, idx) => (
                    <View key={`${attr.trait_type}-${idx}`} style={styles.trait}>
                      <Text style={styles.traitKey}>{attr.trait_type}</Text>
                      <Text style={styles.traitValue}>{String(attr.value)}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={styles.muted}>This token publishes no traits.</Text>
              )}
            </View>
          ) : null}
        </SafeAreaView>
      </Modal>
    </ScreenScaffold>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1 },
    center: { alignItems: 'center', gap: 12, paddingVertical: 48 },
    muted: { color: colors.textMuted, fontSize: 14, lineHeight: 20, textAlign: 'center' },
    pressed: { opacity: 0.7 },
    emptyCard: {
      alignItems: 'center',
      gap: 10,
      paddingVertical: 48,
      paddingHorizontal: 24,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: colors.border,
      borderRadius: 20,
      backgroundColor: colors.surface,
    },
    emptyTitle: {
      fontFamily: fontFamily.heading,
      fontSize: 22,
      color: colors.textStrong,
      textAlign: 'center',
    },
    errorCard: {
      alignItems: 'center',
      gap: 10,
      paddingVertical: 40,
      paddingHorizontal: 24,
      borderWidth: 1,
      borderColor: colors.danger,
      borderRadius: 20,
      backgroundColor: colors.dangerSurface,
    },
    errorTitle: { color: colors.danger, fontSize: 18, fontWeight: '700', textAlign: 'center' },
    errorBody: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, textAlign: 'center' },
    retryButton: {
      backgroundColor: colors.danger,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 24,
      marginTop: 8,
    },
    retryLabel: { color: '#FFF', fontSize: 14, fontWeight: '700' },
    ghostButton: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 24,
      marginTop: 8,
    },
    ghostLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
    grid: { gap: 12, paddingBottom: 32 },
    row: { gap: 12 },
    card: {
      flex: 1,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      overflow: 'hidden',
      backgroundColor: colors.surface,
    },
    tile: { position: 'relative', aspectRatio: 1, backgroundColor: colors.surfaceMd },
    tileImage: { width: '100%', height: '100%' },
    tileFallback: {
      width: '100%',
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      padding: 12,
      backgroundColor: colors.surfaceMd,
    },
    fallbackGlyph: { color: colors.accent, fontSize: 28 },
    fallbackName: { color: colors.textPrimary, fontSize: 13, fontWeight: '600', textAlign: 'center' },
    fallbackHint: { color: colors.textMuted, fontSize: 11, textAlign: 'center' },
    tokenBadge: {
      position: 'absolute',
      top: 8,
      left: 8,
      backgroundColor: 'rgba(0,0,0,0.75)',
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    tokenBadgeLabel: { color: '#FDDA24', fontSize: 12, fontWeight: '700' },
    cardBody: { padding: 12, gap: 2 },
    collection: {
      color: colors.positive,
      fontSize: 11,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    cardTitle: { color: colors.textStrong, fontSize: 15, fontWeight: '600' },
    contract: { color: colors.textMuted, fontSize: 12, fontFamily: fontFamily.address },
    modalRoot: { flex: 1, backgroundColor: colors.background },
    closeRow: { paddingHorizontal: 20, paddingVertical: 12 },
    closeLabel: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
    modalBody: { paddingHorizontal: 20, paddingBottom: 32, gap: 10 },
    detailImage: { width: '100%', aspectRatio: 1, borderRadius: 12, backgroundColor: colors.surfaceMd },
    detailFallback: {
      width: '100%',
      aspectRatio: 1,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: 24,
      backgroundColor: colors.surfaceMd,
    },
    detailCollection: {
      color: colors.positive,
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    detailTitle: { fontFamily: fontFamily.heading, fontSize: 26, color: colors.textStrong },
    detailDesc: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
    propsBox: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      padding: 14,
      gap: 8,
    },
    propRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
    propKey: { color: colors.textMuted, fontSize: 13 },
    propValue: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
    mono: { fontFamily: fontFamily.address },
    traits: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    trait: {
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      minWidth: '47%',
      flexGrow: 1,
    },
    traitKey: { color: colors.textMuted, fontSize: 11, textTransform: 'uppercase' },
    traitValue: { color: colors.textPrimary, fontSize: 13, fontWeight: '600', marginTop: 2 },
  });
