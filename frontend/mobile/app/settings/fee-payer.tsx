/**
 * Fee-payer settings — the mobile port of the web wallet's
 * `app/settings/fee-payer/page.tsx` (#829).
 *
 * The smart wallet holds the funds, but a separate classic account — the fee
 * payer — signs and pays the network fee for every transaction. Until now it
 * was invisible on mobile until a transaction failed for want of gas, which is
 * exactly where a wallet recovered onto a new device starts. This screen shows
 * its address, balance and derivation, with a copy action and a QR so funding
 * it does not mean retyping 56 characters.
 *
 * The QR and the copy action are fed only by `info.address`, the fee-payer —
 * never the smart wallet's C… address, which cannot pay fees.
 *
 * The passkey check is offered for every passkey wallet, not only one whose
 * derivation was never recorded. The label is a stored record, written by
 * whichever code path last set the key; "Passkey (PRF)" therefore means
 * someone asserted it, not that anyone compared it. Only
 * `verifyFeePayerWithPasskey` compares — it evaluates the PRF, derives a key
 * and checks it against the key actually in use — so a user who wants to know
 * whether their fee payer really is reproducible from their passkey has to be
 * able to run it. Gating the button on `unknown` withheld it from exactly the
 * labels worth questioning. The check is read-only: nothing is signed and no
 * key is changed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';
import { useTheme } from '../../hooks/useTheme';
import {
  fetchFeePayerBalance,
  getFeePayerInfo,
  describeFeePayerSource,
  verifyFeePayerWithPasskey,
  type FeePayerBalance,
  type FeePayerInfo,
} from '../../lib/feePayerSource';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';

/**
 * A QR is read by a camera, not by a person, so it keeps full contrast in both
 * themes rather than following the palette.
 */
const QR_BACKGROUND = '#FFFFFF';
const QR_FOREGROUND = '#000000';

export default function FeePayerSettingsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [info, setInfo] = useState<FeePayerInfo | null | undefined>(undefined);
  const [balance, setBalance] = useState<FeePayerBalance | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await getFeePayerInfo().catch(() => null);
    setInfo(next);
    if (next) setBalance(await fetchFeePayerBalance(next.address));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCopy() {
    if (!info) return;
    await Clipboard.setStringAsync(info.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleVerify() {
    setVerifying(true);
    setVerifyNote(null);
    try {
      const result = await verifyFeePayerWithPasskey();
      if (!result.ok) {
        setVerifyNote(
          result.reason === 'no-prf'
            ? 'Your passkey did not return a PRF secret, so the derivation could not be checked.'
            : 'No passkey is registered on this device.',
        );
      } else {
        // Confirming a label leaves the screen looking identical, so the
        // result has to be said out loud or the check reads as a no-op.
        setVerifyNote(
          result.source === 'prf'
            ? 'Checked just now: your passkey derives this exact address.'
            : 'Checked just now: your passkey derives a different address, so this fee payer was not derived from it.',
        );
      }
      await refresh();
    } catch {
      setVerifyNote('The passkey check did not complete. Try again.');
    } finally {
      setVerifying(false);
    }
  }

  const copy = info ? describeFeePayerSource(info.source) : null;

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="fee-payer-screen">
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
      <FlowHeader title="Fee payer" />
      <Text style={styles.sectionBody}>
        Your wallet contract holds your funds, but a separate account — the fee payer — signs and pays
        the network fee for every transaction. It needs a little XLM, or transactions fail.
      </Text>

      {info === undefined && <ActivityIndicator style={styles.loading} color={colors.accent} />}

      {info === null && (
        <Text style={styles.sectionBody}>This network has no wallet on this device, so there is no fee payer.</Text>
      )}

      {info && copy && (
        <>
          {info.source === 'random' && (
            <View testID="fee-payer-random-warning" style={styles.warningCard}>
              <Text style={styles.warningTitle}>Random fallback fee payer</Text>
              <Text style={styles.warningBody}>
                Your passkey did not provide a PRF secret when this was set up, so this account was
                generated at random. It cannot be re-derived from your passkey: on another device the
                wallet gets a different, empty fee payer that must be funded before it can transact.
              </Text>
            </View>
          )}

          <Text style={styles.sectionLabel}>ADDRESS</Text>
          <View style={styles.card}>
            <View style={styles.qrFrame}>
              <QRCode value={info.address} size={168} backgroundColor={QR_BACKGROUND} color={QR_FOREGROUND} />
            </View>
            <Text testID="fee-payer-address" selectable style={styles.address}>
              {info.address}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy fee payer address"
              onPress={handleCopy}
              style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}
            >
              <Text style={styles.copyText}>{copied ? 'Copied' : 'Copy address'}</Text>
            </Pressable>
          </View>

          <Text style={styles.sectionLabel}>BALANCE</Text>
          <View style={styles.card}>
            <Text testID="fee-payer-balance" style={styles.rowLabel}>
              {balanceLabel(balance)}
            </Text>
            {balance?.state === 'unfunded' && (
              <Text style={styles.rowDetail}>
                This account is not on the network yet. Send it some XLM — scan or copy the address
                above — before making a transaction.
              </Text>
            )}
            {balance?.state === 'error' && (
              <Text style={styles.rowDetail}>The balance could not be checked. Reopen this screen to retry.</Text>
            )}
          </View>

          <Text style={styles.sectionLabel}>DERIVATION</Text>
          <View style={styles.card}>
            <Text testID="fee-payer-source" style={styles.rowLabel}>
              {copy.label}
            </Text>
            <Text style={styles.rowDetail}>{copy.description}</Text>
            {info.source !== 'keypair' && (
              <Pressable
                accessibilityRole="button"
                testID="fee-payer-verify"
                onPress={handleVerify}
                disabled={verifying}
                style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}
              >
                <Text style={styles.copyText}>
                  {verifying
                    ? 'Checking…'
                    : info.source === 'unknown'
                      ? 'Check with passkey'
                      : 'Re-check with passkey'}
                </Text>
              </Pressable>
            )}
            {verifyNote && <Text testID="fee-payer-verify-note" style={styles.rowDetail}>{verifyNote}</Text>}
          </View>
        </>
      )}
    </ScrollView>
    </SafeAreaView>
  );
}

function balanceLabel(balance: FeePayerBalance | null): string {
  if (!balance) return 'Checking…';
  if (balance.state === 'funded') return `${balance.xlm} XLM`;
  if (balance.state === 'unfunded') return 'Not funded';
  return 'Unavailable';
}

/**
 * Settings sub-screens are flow screens: a back chevron and a Lora-italic
 * title through `FlowHeader`. This one drew its own `fontWeight: '700'`
 * heading and had no header at all, so it was reachable and then not leavable
 * except by the system gesture, in a typeface the app does not use anywhere
 * else. `fontWeight` is the tell — the brand fonts are families (Lora, Anton,
 * Inter, Inconsolata), so asking for a weight gets the system face at that
 * weight and silently opts the screen out of the type system.
 *
 * The QR keeps literal black-on-white. That is not an un-themed colour: a
 * scanner needs the quiet zone and the modules at full contrast, and a code
 * drawn in palette greys on a dark surface does not read.
 */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      backgroundColor: colors.background,
      flex: 1,
    },
    content: {
      gap: 8,
      paddingHorizontal: 24,
      paddingTop: 16,
      paddingBottom: 48,
    },
    loading: {
      marginTop: 24,
    },
    sectionLabel: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      marginTop: 20,
      textTransform: 'uppercase',
    },
    sectionBody: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13.5,
      lineHeight: 20,
      marginTop: 10,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: 1,
      gap: 8,
      marginTop: 8,
      padding: 16,
    },
    qrFrame: {
      alignSelf: 'center',
      backgroundColor: QR_BACKGROUND,
      borderRadius: 12,
      marginBottom: 8,
      padding: 12,
    },
    address: {
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 13,
      lineHeight: 20,
      textAlign: 'center',
    },
    copyButton: {
      alignSelf: 'center',
      borderColor: colors.accent,
      borderRadius: 100,
      borderWidth: 1,
      marginTop: 4,
      paddingHorizontal: 16,
      paddingVertical: 9,
    },
    copyText: {
      color: colors.accentText,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
    },
    pressed: {
      opacity: 0.7,
    },
    rowLabel: {
      color: colors.textPrimary,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    rowDetail: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    warningCard: {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
      borderRadius: 16,
      borderWidth: 1,
      gap: 4,
      marginTop: 12,
      padding: 16,
    },
    warningTitle: {
      color: colors.danger,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 14,
    },
    warningBody: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
  });
