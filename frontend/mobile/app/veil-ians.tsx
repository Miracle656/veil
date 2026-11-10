/**
 * Veil-ians — the twenty figures, bought from the phone.
 *
 * The native counterpart of `frontend/wallet/app/veil-ians/page.tsx`, reading
 * the same contract and showing the same twenty. What is deliberately NOT the
 * same is the art: the web page serves the JPEGs from its own `public/`, and
 * this one loads them over the network rather than bundling 7 MB into an APK
 * that people download on mobile data.
 *
 * Three states this screen refuses to collapse, each of which has cost somebody
 * money elsewhere in this codebase:
 *
 * 1. **Sold, available, and "could not read."** A failed read offers nothing
 *    rather than offering everything.
 * 2. **No name, and could not check for one.** The gate is read from the
 *    registry; null is not "you have no name".
 * 3. **Short of USDC, and could not read the balance.** Only a balance that was
 *    actually read can say someone is short.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { ScreenScaffold } from '../components/ScreenScaffold';
import { useTheme } from '../hooks/useTheme';
import { getWalletAddress } from '../lib/walletStore';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { errorMessage } from '../lib/errorMessage';
import { isPasskeyCancellation } from '../lib/passkeyOutcome';
import {
  COLLECTION_SIZE,
  FIGURES,
  figureImageUrl,
  pad,
  type Figure,
} from '../lib/veilIansFigures';
import {
  type BuyerState,
  buyFigure,
  collectionContractId,
  formatUsdc,
  readBuyerState,
  soldFigures,
  veilIanErrorMessage,
} from '../lib/veilIans';

type Shelf = 'available' | 'sold' | 'yours';

export default function VeilIansScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // The smart wallet's `C…` address, which is the buyer: `buy` spends its USDC
  // and `__check_auth` is what authorises the call.
  const [contractAddress, setContractAddress] = useState<string | null>(null);

  const [sold, setSold] = useState<number[] | null>(null);
  const [soldReadFailed, setSoldReadFailed] = useState(false);
  const [owned, setOwned] = useState<number[]>([]);
  const [buyer, setBuyer] = useState<BuyerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [open, setOpen] = useState<Figure | null>(null);
  const [busy, setBusy] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [boughtHash, setBoughtHash] = useState<string | null>(null);

  const collectionId = useMemo(() => collectionContractId(), []);

  useEffect(() => {
    void getWalletAddress()
      .then(setContractAddress)
      .catch(() => setContractAddress(null));
  }, []);

  const load = useCallback(async () => {
    if (!collectionId) {
      setLoading(false);
      return;
    }
    const list = await soldFigures();
    setSold(list);
    setSoldReadFailed(list === null);
    if (contractAddress) setBuyer(await readBuyerState(contractAddress));
    setLoading(false);
  }, [collectionId, contractAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  /** null = cannot tell, which is never rendered as "available". */
  const shelfOf = useCallback(
    (id: number): Shelf | null => {
      if (owned.includes(id)) return 'yours';
      if (sold === null) return null;
      return sold.includes(id) ? 'sold' : 'available';
    },
    [sold, owned],
  );

  const available = useMemo(
    () => FIGURES.filter((f) => shelfOf(f.id) === 'available').length,
    [shelfOf],
  );

  const price = buyer ? formatUsdc(buyer.priceStroops) : '5';
  const openShelf = open ? shelfOf(open.id) : null;
  const canBuy =
    Boolean(contractAddress) &&
    Boolean(collectionId) &&
    openShelf === 'available' &&
    buyer?.hasName === true &&
    !buyer.short &&
    !busy &&
    !boughtHash;

  const handleBuy = async () => {
    if (!contractAddress || !open) return;
    setBusy(true);
    setBuyError(null);
    try {
      const hash = await buyFigure(contractAddress, open.id);
      setBoughtHash(hash);
      setOwned((prev) => (prev.includes(open.id) ? prev : [...prev, open.id]));
      await load();
    } catch (err: unknown) {
      if (isPasskeyCancellation(err)) {
        setBuyError('Cancelled. Nothing was charged.');
      } else {
        setBuyError(veilIanErrorMessage(err, collectionId) ?? errorMessage(err));
      }
      // It may have gone while this was in flight.
      void load();
    } finally {
      setBusy(false);
    }
  };

  const closeSheet = () => {
    setOpen(null);
    setBuyError(null);
    setBoughtHash(null);
  };

  return (
    <ScreenScaffold
      eyebrow="VEIL-IANS"
      title="Own a Veil-ian"
      description={`Twenty veiled figures made for the Veil community. Each is one of one, kept in your wallet. ${price} USDC each, to anyone who holds a Veil name.`}
      testID="veil-ians-screen"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
    >
      <View style={styles.facts}>
        <Fact styles={styles} value={String(COLLECTION_SIZE)} label="Pieces" />
        <Fact
          styles={styles}
          value={!collectionId || sold === null ? '—' : String(available)}
          label="Available"
        />
        <Fact styles={styles} value={`${price} USDC`} label="Each" />
      </View>

      {!collectionId && (
        <Notice styles={styles}>
          The collection is not on sale on this network. Everything below is the real art and the
          real traits.
        </Notice>
      )}
      {collectionId && soldReadFailed && (
        <Notice styles={styles} tone="warn">
          Could not read which pieces are still available, so none are offered. Pull down to try
          again.
        </Notice>
      )}
      {collectionId && !contractAddress && (
        <Notice styles={styles}>Open your wallet to buy a piece. You will also need a Veil name.</Notice>
      )}
      {collectionId && contractAddress && buyer?.hasName === false && (
        <Pressable onPress={() => router.push('/names')}>
          <Notice styles={styles} tone="warn">
            Veil-ians are for name holders. Tap to get a Veil name first — you keep the piece
            afterwards even if the name lapses.
          </Notice>
        </Pressable>
      )}
      {collectionId && contractAddress && buyer?.hasName === null && (
        <Notice styles={styles}>
          Could not check whether you hold a Veil name. That is not a statement that you do not
          have one.
        </Notice>
      )}

      {loading ? (
        <ActivityIndicator color={colors.accent} style={styles.loading} />
      ) : (
        <View style={styles.grid}>
          {FIGURES.map((figure) => {
            const shelf = shelfOf(figure.id);
            return (
              <Pressable
                key={figure.id}
                onPress={() => {
                  setOpen(figure);
                  setBuyError(null);
                  setBoughtHash(null);
                }}
                style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                accessibilityRole="button"
                accessibilityLabel={`Veil-ian ${pad(figure.id)}, ${figure.crown} crown`}
              >
                <Image
                  source={{ uri: figureImageUrl(figure.id) }}
                  style={[styles.art, shelf === 'sold' && styles.artSold]}
                  resizeMode="cover"
                />
                <View style={styles.cardBody}>
                  <View style={styles.cardTopRow}>
                    <Text style={styles.cardTitle}>#{pad(figure.id)}</Text>
                    <Text style={styles.oneOfOne}>1 of 1</Text>
                  </View>
                  <Text style={styles.cardStatus(shelf)} numberOfLines={1}>
                    {shelf === 'available'
                      ? `${price} USDC`
                      : shelf === 'sold'
                        ? 'Taken'
                        : shelf === 'yours'
                          ? 'In your wallet'
                          : 'Unknown'}
                  </Text>
                  <Text style={styles.cardTraits} numberOfLines={1}>
                    {figure.crown} · {figure.palette}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}

      <Modal visible={open !== null} animationType="slide" transparent onRequestClose={closeSheet}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            {open && (
              <ScrollView showsVerticalScrollIndicator={false}>
                <Image
                  source={{ uri: figureImageUrl(open.id) }}
                  style={styles.sheetArt}
                  resizeMode="cover"
                />
                <Text style={styles.sheetEyebrow}>
                  VEIL-IANS · {pad(open.id)} / {COLLECTION_SIZE}
                </Text>
                <Text style={styles.sheetTitle}>Veil-ian #{pad(open.id)}</Text>

                <View style={styles.rows}>
                  <Row styles={styles} label="Price" value={`${price} USDC`} />
                  <Row styles={styles} label="Edition" value="1 of 1" />
                  <Row styles={styles} label="Crown" value={open.crown} />
                  <Row styles={styles} label="Aperture" value={open.aperture} />
                  <Row styles={styles} label="Ornament" value={open.ornament} />
                  <Row styles={styles} label="Palette" value={open.palette} />
                  <Row styles={styles} label="Hem" value={open.hem} />
                  <Row styles={styles} label="Network fee" value="Covered by Veil" />
                </View>

                {boughtHash ? (
                  <View style={styles.doneBox}>
                    <Text style={styles.doneText}>
                      It is now in your Veil wallet, next to your money.
                    </Text>
                    <Pressable
                      style={styles.primaryButton}
                      onPress={() => {
                        closeSheet();
                        router.push('/nfts');
                      }}
                    >
                      <Text style={styles.primaryButtonText}>See it in your wallet</Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    {buyer?.short && (
                      <Text style={styles.shortText}>
                        Not enough USDC in your wallet — you have{' '}
                        {formatUsdc(buyer.balanceStroops ?? 0n)}.
                      </Text>
                    )}
                    {openShelf === 'sold' && (
                      <Text style={styles.mutedText}>
                        This one is already taken. The others are still there.
                      </Text>
                    )}
                    <Pressable
                      style={[styles.primaryButton, !canBuy && styles.buttonDisabled]}
                      disabled={!canBuy}
                      onPress={handleBuy}
                      accessibilityRole="button"
                    >
                      {busy ? (
                        <ActivityIndicator color={colors.onAccent} />
                      ) : (
                        <Text style={styles.primaryButtonText}>Buy for {price} USDC</Text>
                      )}
                    </Pressable>
                    {busy && (
                      <Text style={styles.mutedText}>
                        Use your fingerprint, face or screen lock to sign. Nothing is charged until
                        you do.
                      </Text>
                    )}
                  </>
                )}

                {buyError && <Text style={styles.errorText}>{buyError}</Text>}

                <Pressable style={styles.secondaryButton} onPress={closeSheet}>
                  <Text style={styles.secondaryButtonText}>Back to the collection</Text>
                </Pressable>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </ScreenScaffold>
  );
}

function Fact({
  styles,
  value,
  label,
}: {
  styles: ReturnType<typeof createStyles>;
  value: string;
  label: string;
}) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factValue}>{value}</Text>
      <Text style={styles.factLabel}>{label}</Text>
    </View>
  );
}

function Row({
  styles,
  label,
  value,
}: {
  styles: ReturnType<typeof createStyles>;
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

function Notice({
  styles,
  tone = 'muted',
  children,
}: {
  styles: ReturnType<typeof createStyles>;
  tone?: 'muted' | 'warn';
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.notice, tone === 'warn' && styles.noticeWarn]}>
      <Text style={styles.noticeText}>{children}</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) => {
  const base = StyleSheet.create({
    facts: {
      flexDirection: 'row',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      marginBottom: 16,
    },
    fact: { flex: 1, paddingVertical: 14 },
    factValue: {
      fontSize: 22,
      fontWeight: '600',
      color: colors.textStrong,
      fontVariant: ['tabular-nums'],
    },
    factLabel: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

    notice: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 12,
      marginBottom: 10,
    },
    noticeWarn: { borderColor: colors.accent, backgroundColor: colors.surfaceMd },
    noticeText: { fontSize: 13, lineHeight: 19, color: colors.textSecondary },

    loading: { marginTop: 32 },

    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 },
    card: {
      width: '47%',
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    cardPressed: { opacity: 0.7 },
    art: { width: '100%', aspectRatio: 3 / 4, backgroundColor: colors.surfaceMd },
    artSold: { opacity: 0.4 },
    cardBody: { padding: 10, gap: 2 },
    cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    cardTitle: { fontSize: 14, fontWeight: '600', color: colors.textStrong },
    oneOfOne: { fontSize: 11, color: colors.textMuted },
    cardTraits: { fontSize: 11, color: colors.textFaint },

    scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
    // surfaceRaised, not surface: this floats over a scrim, and `surface` is
    // translucent — over anything but the page background it tints through.
    sheet: {
      backgroundColor: colors.surfaceRaised,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      padding: 20,
      maxHeight: '92%',
    },
    sheetArt: {
      width: '100%',
      aspectRatio: 3 / 4,
      borderRadius: 18,
      backgroundColor: colors.surfaceMd,
      marginBottom: 16,
    },
    sheetEyebrow: {
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1.6,
      color: colors.accentText,
    },
    sheetTitle: {
      fontSize: 24,
      fontWeight: '700',
      color: colors.textStrong,
      marginTop: 4,
      marginBottom: 12,
    },

    rows: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      marginBottom: 16,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 9,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      gap: 12,
    },
    rowLabel: { fontSize: 13, color: colors.textMuted },
    rowValue: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1, textAlign: 'right' },

    primaryButton: {
      backgroundColor: colors.accent,
      borderRadius: 999,
      height: 52,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
    },
    primaryButtonText: { fontSize: 15, fontWeight: '700', color: colors.onAccent },
    buttonDisabled: { opacity: 0.4 },
    secondaryButton: { height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
    secondaryButtonText: { fontSize: 14, color: colors.textMuted },

    doneBox: { gap: 10, marginBottom: 4 },
    doneText: { fontSize: 15, color: colors.textPrimary, lineHeight: 21 },
    shortText: { fontSize: 13, color: colors.danger, marginBottom: 8 },
    mutedText: { fontSize: 13, color: colors.textMuted, marginTop: 8, lineHeight: 19 },
    errorText: { fontSize: 13, color: colors.danger, marginTop: 10, lineHeight: 19 },
  });

  return {
    ...base,
    /** Status line colour follows the shelf, so it is a function rather than a key. */
    cardStatus: (shelf: Shelf | null) => ({
      fontSize: 13,
      fontWeight: '600' as const,
      color:
        shelf === 'available'
          ? colors.textStrong
          : shelf === 'yours'
            ? colors.accentText
            : shelf === 'sold'
              ? colors.textMuted
              : colors.textFaint,
    }),
  };
};
