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

import { SafeAreaView } from 'react-native-safe-area-context';
import { FlowHeader } from '../components/FlowHeader';
import { SlideToConfirm } from '../components/SlideToConfirm';
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
    <SafeAreaView style={styles.screen} edges={['top']} testID="veil-ians-screen">
      <View style={styles.header}>
        <FlowHeader title="Veil-ians" />
      </View>

      <ScrollView
        style={styles.flex}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
      >
        <View style={styles.field}>
          <Text style={styles.eyebrow}>TWENTY FIGURES</Text>
          <Text style={styles.question}>Own a Veil-ian</Text>
          <Text style={styles.hint}>
            Each is one of one, kept in your wallet. {price} USDC, to anyone who holds a Veil name.
          </Text>
        </View>
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
                style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`Veil-ian ${pad(figure.id)}, ${figure.crown} crown`}
              >
                <Image
                  source={{ uri: figureImageUrl(figure.id) }}
                  style={[styles.art, shelf === 'sold' && styles.artSold]}
                  resizeMode="cover"
                />
                <View style={styles.tileBody}>
                  <View style={styles.tileTopRow}>
                    <Text style={styles.tileTitle}>#{pad(figure.id)}</Text>
                    <Text style={styles.oneOfOne}>1 of 1</Text>
                  </View>
                  <Text style={styles.tileStatus(shelf)} numberOfLines={1}>
                    {shelf === 'available'
                      ? `${price} USDC`
                      : shelf === 'sold'
                        ? 'Taken'
                        : shelf === 'yours'
                          ? 'In your wallet'
                          : 'Unknown'}
                  </Text>
                  <Text style={styles.tileTraits} numberOfLines={1}>
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
                  resizeMode="contain"
                />
                <Text style={styles.eyebrow}>
                  VEIL-IANS · {pad(open.id)} / {COLLECTION_SIZE}
                </Text>
                <Text style={styles.question}>Veil-ian #{pad(open.id)}</Text>

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
                  <View style={styles.field}>
                    <Text style={styles.question}>
                      It is now in your Veil wallet, next to your money.
                    </Text>
                    <Pressable
                      style={styles.primaryBtn}
                      onPress={() => {
                        closeSheet();
                        router.push('/nfts');
                      }}
                    >
                      <Text style={styles.primaryText}>See it in your wallet</Text>
                    </Pressable>
                  </View>
                ) : (
                  <>
                    {buyer?.short && (
                      <Text style={styles.hintWarn}>
                        Not enough USDC in your wallet — you have{' '}
                        {formatUsdc(buyer.balanceStroops ?? 0n)}.
                      </Text>
                    )}
                    {openShelf === 'sold' && (
                      <Text style={styles.hint}>
                        This one is already taken. The others are still there.
                      </Text>
                    )}
                    {busy ? (
                      <View style={styles.busyRow}>
                        <ActivityIndicator color={colors.accent} />
                        <Text style={styles.centeredHint}>Confirming on Stellar…</Text>
                      </View>
                    ) : (
                      <>
                        <SlideToConfirm
                          testID="veil-ians-slide-to-buy"
                          label={`Slide to buy for ${price} USDC`}
                          disabled={!canBuy}
                          onConfirm={() => void handleBuy()}
                        />
                        <Text style={styles.centeredHint}>Then confirm with your passkey</Text>
                      </>
                    )}
                  </>
                )}

                {buyError && <Text style={styles.errorText}>{buyError}</Text>}

                <Pressable style={styles.secondaryBtn} onPress={closeSheet}>
                  <Text style={styles.secondaryText}>Back to the collection</Text>
                </Pressable>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
      </ScrollView>
    </SafeAreaView>
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
    <View style={tone === 'warn' ? styles.errorCard : styles.card}>
      <Text style={tone === 'warn' ? styles.errorText : styles.hint}>{children}</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) => {
  const base = StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    body: { padding: 20, paddingBottom: 60, gap: 16 },

    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 16,
      gap: 8,
    },
    errorCard: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      borderRadius: 12,
      padding: 12,
      backgroundColor: colors.dangerSurface,
    },
    errorText: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },

    eyebrow: { color: colors.textMuted, fontFamily: fontFamily.accent, fontSize: 11, letterSpacing: 0.8 },
    question: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },
    hint: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    hintWarn: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    centeredHint: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      textAlign: 'center',
    },

    field: { gap: 6 },
    label: { color: colors.textMuted, fontFamily: fontFamily.accent, fontSize: 11, letterSpacing: 0.8 },

    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 4,
      gap: 12,
    },
    rowLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 13, flexShrink: 1 },
    rowValue: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
      flexShrink: 1,
      textAlign: 'right',
    },

    facts: {
      flexDirection: 'row',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    fact: { flex: 1, paddingVertical: 14 },
    factValue: {
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 22,
    },
    factLabel: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12, marginTop: 2 },

    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    tile: {
      width: '47%',
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    art: { width: '100%', aspectRatio: 3 / 4, backgroundColor: colors.surfaceMd },
    artSold: { opacity: 0.4 },
    tileBody: { padding: 10, gap: 2 },
    tileTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    tileTitle: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },
    oneOfOne: { color: colors.textMuted, fontFamily: fontFamily.address, fontSize: 11 },
    tileTraits: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 11 },

    // surfaceRaised, not surface: a sheet floats over a scrim, and `surface`
    // is translucent — over anything but the page background it tints through.
    scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: colors.surfaceRaised,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      padding: 20,
      maxHeight: '92%',
      gap: 12,
    },
    // Capped, not `aspectRatio: 3/4`.
    //
    // At full width that aspect makes the image 549px tall on a 412×860 phone,
    // which with eight trait rows put the buy slider about 230px below the fold
    // — you had to scroll an already-scrolled sheet to reach the only control
    // that does anything. Measured, not guessed.
    //
    // `contain` rather than `cover` because these are full-length figures: a
    // cropped one shows a band of cloth and no crown, which is the half that
    // tells them apart.
    sheetArt: {
      width: '100%',
      height: 260,
      borderRadius: 18,
      backgroundColor: colors.surfaceMd,
    },
    rows: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },

    busyRow: { gap: 10, paddingVertical: 12 },

    primaryBtn: {
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 16,
      alignItems: 'center',
    },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },
    secondaryBtn: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 999,
      paddingVertical: 16,
      alignItems: 'center',
    },
    secondaryText: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 16 },

    pressed: { opacity: 0.85 },
    loading: { marginTop: 32 },
  });

  return {
    ...base,
    /** Status colour follows the shelf, so it is a function rather than a key. */
    tileStatus: (shelf: Shelf | null) => ({
      color:
        shelf === 'available'
          ? colors.textStrong
          : shelf === 'yours'
            ? colors.accentText
            : shelf === 'sold'
              ? colors.textMuted
              : colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
    }),
  };
};
