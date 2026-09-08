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
import { checkReceiveReadiness, readinessMessage, type ReceiveReadiness } from '../lib/receiveReadiness';
import { enableUsdc } from '../lib/enableUsdc';
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
  const [readiness, setReadiness] = useState<ReceiveReadiness | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const qrRef = useRef<QRRef>(null);

  useEffect(() => {
    getWalletAddress()
      .then((a) => a && setAddress(a))
      .catch(() => undefined);
    getFeePayerAddress()
      .then((fp) => setFeePayer(fp))
      .catch(() => undefined);
  }, []);

  // Whether the payable address can actually take a USDC payment today. A
  // brand new wallet cannot: the account has to exist and hold a trustline
  // before anyone can pay it, and both cost reserve the user does not have.
  // Better to say so on this screen than to have someone hand out an address
  // that silently rejects their payout.
  useEffect(() => {
    if (!feePayer) return;
    let cancelled = false;
    void checkReceiveReadiness(feePayer).then((r) => {
      if (!cancelled) setReadiness(r);
    });
    return () => {
      cancelled = true;
    };
  }, [feePayer]);

  async function handleCopyFeePayer() {
    if (!feePayer) return;
    await Clipboard.setStringAsync(feePayer);
    setCopiedFp(true);
    setTimeout(() => setCopiedFp(false), 1200);
  }

  const isContract = address.startsWith('C');

  /** Add the USDC trustline with the user's own key, then re-check. */
  async function handleEnableUsdc() {
    if (!feePayer) return;
    setEnableError(null);
    setEnabling(true);
    try {
      await enableUsdc();
      setReadiness(await checkReceiveReadiness(feePayer));
    } catch (err) {
      setEnableError(err instanceof Error ? err.message : 'Could not add the USDC trustline.');
    } finally {
      setEnabling(false);
    }
  }

  // The address on the QR is the one an ordinary sender can actually pay. For a
  // smart wallet that is the classic G account, NOT the contract: a classic
  // payment operation cannot name a contract as its destination, so an exchange
  // or a payroll tool paying the C address gets a rejection. This screen used
  // to lead with the C and call it "use this for most senders", which was
  // exactly backwards.
  const payable = isContract && feePayer ? feePayer : address;
  const payUri = buildSep7PayUri({ destination: payable });

  async function handleCopy() {
    await Clipboard.setStringAsync(payable);
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
          <Text style={styles.cardLabel}>Your address</Text>
          <Text style={styles.cardSub}>
            {isContract
              ? 'Give this to an exchange, an employer, or anyone paying you'
              : 'Use this for most senders & exchanges'}
          </Text>

          <View style={styles.qrFrame}>
            <QRCode
              value={payUri}
              size={168}
              backgroundColor="#F6F7F8"
              color="#0F0F0F"
              getRef={(c) => { qrRef.current = c as unknown as QRRef; }}
            />
          </View>

          <Text testID="receive-address" style={styles.addr}>{shorten(payable)}</Text>

          {/* Whether a payment sent here will actually land. Three distinct
              answers, because "we could not check" must never render as "this
              cannot receive" — someone waiting on a payout decides whether to
              send the address based on this line. */}
          {readiness && readiness.state !== 'ready' && (
            <View
              testID="receive-readiness"
              style={[
                styles.readiness,
                readiness.state === 'unknown' ? styles.readinessUnknown : styles.readinessBlocked,
              ]}
            >
              <Text style={styles.readinessTitle}>
                {readiness.state === 'unknown' ? 'Not checked' : 'Not ready to receive USDC'}
              </Text>
              <Text style={styles.readinessBody}>{readinessMessage(readiness)}</Text>

              {/* The one state the app can fix on its own: the account exists
                  and holds enough XLM, it just does not trust USDC yet. */}
              {readiness.state === 'needs-trustline' && (
                <Pressable
                  testID="receive-enable-usdc"
                  onPress={handleEnableUsdc}
                  disabled={enabling}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.enableBtn,
                    (enabling || pressed) && styles.pressed,
                  ]}
                >
                  <Text style={styles.enableLabel}>
                    {enabling ? 'Enabling…' : 'Enable USDC'}
                  </Text>
                </Pressable>
              )}
              {enableError ? <Text style={styles.enableError}>{enableError}</Text> : null}
            </View>
          )}
          {readiness?.state === 'ready' && (
            <Text testID="receive-readiness" style={styles.readinessOk}>
              Ready to receive USDC
            </Text>
          )}

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
                {shorten(address, 6, 6)} ·{' '}
                {isContract ? 'Soroban senders only — most cannot pay this' : 'classic address'}
              </Text>
            </View>
          </View>
          <View style={styles.roundBtn}>
            <CopyIcon size={14} color={colors.textSecondary} />
          </View>
        </Pressable>

        {/* The classic account is now the headline address above, so this row
            only exists for the case where it is NOT what the QR shows. */}
        {feePayer && payable !== feePayer && (
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
    // A payout that cannot land is worth a banner, not a caption. Danger
    // colours for "this will be rejected"; a neutral surface for "we could not
    // check", because the two demand different actions from the person reading.
    readiness: {
      marginTop: 14,
      borderRadius: 12,
      borderWidth: 1,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 3,
    },
    readinessBlocked: {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
    },
    readinessUnknown: {
      backgroundColor: colors.surfaceMd,
      borderColor: colors.border,
    },
    readinessTitle: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 13,
    },
    readinessBody: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 12.5,
      lineHeight: 18,
    },
    enableBtn: {
      marginTop: 10,
      alignSelf: 'flex-start',
      borderRadius: 999,
      backgroundColor: colors.accent,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    enableLabel: {
      color: colors.onAccent,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 12.5,
    },
    enableError: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 8,
    },
    readinessOk: {
      color: colors.positive,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 12.5,
      textAlign: 'center',
      marginTop: 12,
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
