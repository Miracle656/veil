import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { FlowHeader } from '../components/FlowHeader';
import { getWalletAddress } from '../lib/walletStore';
import { getFeePayerAddress } from '../lib/activity';
import { buildSep7PayUri } from '../lib/sep7';
import { CopyIcon, DownloadIcon, HexagonIcon, ShareIcon } from '../components/icons';

const FALLBACK = 'GA3DHM4WL2VXPHR7NQKPZ7XK9FQJ2ULTQ6ZT4W2M5N6Q7RSTUVWXK9FQ';

function shorten(a: string, head = 12, tail = 12): string {
  return a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;
}

/** A QR-provider ref exposes toDataURL(cb) to export the code as base64 PNG. */
type QRRef = { toDataURL: (cb: (data: string) => void) => void } | null;

export default function ReceiveScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [address, setAddress] = useState<string>(FALLBACK);
  const [feePayer, setFeePayer] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedFp, setCopiedFp] = useState(false);
  const qrRef = useRef<QRRef>(null);

  useEffect(() => {
    getWalletAddress()
      .then((a) => a && setAddress(a))
      .catch(() => undefined);
    getFeePayerAddress()
      .then((fp) => setFeePayer(fp))
      .catch(() => undefined);
  }, []);

  async function handleCopyFeePayer() {
    if (!feePayer) return;
    await Clipboard.setStringAsync(feePayer);
    setCopiedFp(true);
    setTimeout(() => setCopiedFp(false), 1200);
  }

  const payUri = buildSep7PayUri({ destination: address });
  const isContract = address.startsWith('C');

  async function handleCopy() {
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  async function handleShare() {
    await Share.share({ message: address, title: 'My Veil wallet address' });
  }

  function handleSaveQr() {
    const c = qrRef.current;
    if (!c) return;
    c.toDataURL(async (b64: string) => {
      try {
        const uri = `${FileSystem.cacheDirectory}veil-address-qr.png`;
        await FileSystem.writeAsStringAsync(uri, b64, { encoding: FileSystem.EncodingType.Base64 });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Save or share your QR' });
        }
      } catch {
        // Non-fatal — fall back to sharing the address text.
        await Share.share({ message: address });
      }
    });
  }

  const tiles = [
    { key: 'copy', label: copied ? 'Copied' : 'Copy', Icon: CopyIcon, onPress: handleCopy },
    { key: 'save', label: 'Save QR', Icon: DownloadIcon, onPress: handleSaveQr },
    { key: 'share', label: 'Share', Icon: ShareIcon, onPress: handleShare },
  ];

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="receive-screen">
      <View style={styles.body}>
        <FlowHeader title="Receive" />

        {/* Spending address */}
        <View style={[styles.card, styles.spendingCard]}>
          <Text style={styles.cardLabel}>Spending address</Text>
          <Text style={styles.cardSub}>Use this for most senders & exchanges</Text>

          <View style={styles.qrFrame}>
            <QRCode
              value={payUri}
              size={168}
              backgroundColor="#F6F7F8"
              color="#0F0F0F"
              getRef={(c) => { qrRef.current = c as unknown as QRRef; }}
            />
          </View>

          <Text testID="receive-address" style={styles.addr}>{shorten(address)}</Text>

          <View style={styles.tiles}>
            {tiles.map((t) => (
              <Pressable
                key={t.key}
                testID={`receive-${t.key}`}
                onPress={t.onPress}
                accessibilityRole="button"
                accessibilityLabel={t.label}
                style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
              >
                <t.Icon size={17} color={colors.accent} />
                <Text style={styles.tileLabel}>{t.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Contract address */}
        <Pressable onPress={handleCopy} style={({ pressed }) => [styles.card, styles.contractRow, pressed && styles.pressed]}>
          <View style={styles.contractLeft}>
            <View style={styles.hexBadge}>
              <HexagonIcon size={16} color={colors.lilac} />
            </View>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.contractTitle}>Contract address</Text>
              <Text style={styles.contractSub} numberOfLines={1}>
                {shorten(address, 6, 6)} · {isContract ? 'Soroban wallets only' : 'classic address'}
              </Text>
            </View>
          </View>
          <View style={styles.roundBtn}>
            <CopyIcon size={14} color={colors.textSecondary} />
          </View>
        </Pressable>

        {/* Fee-payer — the classic account that receives bank-style G→G payments
            and pays fees. Shown so it can be funded directly. */}
        {feePayer && address.startsWith('C') && (
          <Pressable onPress={handleCopyFeePayer} style={({ pressed }) => [styles.card, styles.contractRow, pressed && styles.pressed]}>
            <View style={styles.contractLeft}>
              <View style={styles.hexBadge}>
                <CopyIcon size={14} color={colors.lilac} />
              </View>
              <View style={{ flexShrink: 1 }}>
                <Text style={styles.contractTitle}>Spending account</Text>
                <Text style={styles.contractSub} numberOfLines={1}>
                  {shorten(feePayer, 6, 6)} · {copiedFp ? 'copied' : 'classic G — tap to copy'}
                </Text>
              </View>
            </View>
          </Pressable>
        )}

        <Text style={styles.caption}>Incoming funds start earning automatically.</Text>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    body: { flex: 1, paddingHorizontal: 24, paddingTop: 20 },

    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 20,
    },
    spendingCard: { marginTop: 32 },
    cardLabel: {
      color: colors.accent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
      textAlign: 'center',
      marginTop: 24,
    },
    cardSub: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 12,
      textAlign: 'center',
      marginTop: 4,
    },
    qrFrame: {
      alignSelf: 'center',
      backgroundColor: '#F6F7F8',
      borderRadius: 16,
      padding: 16,
      marginTop: 18,
    },
    addr: {
      color: colors.textSecondary,
      fontFamily: fontFamily.address,
      fontSize: 12,
      textAlign: 'center',
      marginTop: 16,
    },
    tiles: {
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 20,
      marginTop: 18,
      marginBottom: 20,
    },
    tile: {
      flex: 1,
      alignItems: 'center',
      gap: 5,
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      paddingVertical: 12,
    },
    tileLabel: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodyMedium,
      fontSize: 12,
    },

    contractRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      marginTop: 12,
    },
    contractLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
    hexBadge: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(183,172,232,0.12)',
      borderWidth: 1,
      borderColor: 'rgba(183,172,232,0.3)',
    },
    contractTitle: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },
    contractSub: { color: colors.textFaint, fontFamily: fontFamily.address, fontSize: 11, marginTop: 1 },
    roundBtn: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceMd,
      borderWidth: 1,
      borderColor: colors.border,
      flexShrink: 0,
    },
    caption: {
      color: colors.textFaint,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 20,
      textAlign: 'center',
      marginTop: 16,
    },
    pressed: { opacity: 0.7 },
  });
