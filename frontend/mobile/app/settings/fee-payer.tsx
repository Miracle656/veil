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
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';

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
    <ScrollView showsVerticalScrollIndicator={false} style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Fee payer</Text>
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
              <QRCode value={info.address} size={168} backgroundColor="#F6F7F8" color="#0F0F0F" />
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
            {info.source === 'unknown' && (
              <Pressable
                accessibilityRole="button"
                onPress={handleVerify}
                disabled={verifying}
                style={({ pressed }) => [styles.copyButton, pressed && styles.pressed]}
              >
                <Text style={styles.copyText}>{verifying ? 'Checking…' : 'Check with passkey'}</Text>
              </Pressable>
            )}
            {verifyNote && <Text style={styles.rowDetail}>{verifyNote}</Text>}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function balanceLabel(balance: FeePayerBalance | null): string {
  if (!balance) return 'Checking…';
  if (balance.state === 'funded') return `${balance.xlm} XLM`;
  if (balance.state === 'unfunded') return 'Not funded';
  return 'Unavailable';
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      backgroundColor: colors.background,
      flex: 1,
    },
    content: {
      gap: 8,
      padding: 24,
      paddingBottom: 48,
    },
    title: {
      color: colors.textStrong,
      fontSize: 28,
      fontWeight: '700',
      marginBottom: 8,
    },
    loading: {
      marginTop: 24,
    },
    sectionLabel: {
      color: colors.textFaint,
      fontSize: 12,
      letterSpacing: 1,
      marginTop: 20,
    },
    sectionBody: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 20,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      gap: 8,
      marginTop: 8,
      padding: 16,
    },
    qrFrame: {
      alignSelf: 'center',
      backgroundColor: '#F6F7F8',
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
      borderRadius: 999,
      borderWidth: 1,
      marginTop: 4,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    copyText: {
      color: colors.accentText,
      fontSize: 14,
      fontWeight: '600',
    },
    pressed: {
      opacity: 0.7,
    },
    rowLabel: {
      color: colors.textPrimary,
      fontSize: 15,
      fontWeight: '600',
    },
    rowDetail: {
      color: colors.textMuted,
      fontSize: 13,
      lineHeight: 18,
    },
    warningCard: {
      borderColor: colors.danger,
      borderRadius: 12,
      borderWidth: 1,
      gap: 4,
      marginTop: 12,
      padding: 16,
    },
    warningTitle: {
      color: colors.danger,
      fontSize: 14,
      fontWeight: '700',
    },
    warningBody: {
      color: colors.textSecondary,
      fontSize: 13,
      lineHeight: 18,
    },
  });
