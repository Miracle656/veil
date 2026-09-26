/**
 * Danger zone — the mobile counterpart of the web wallet's
 * `app/settings/danger/page.tsx`.
 *
 * The web page is the home of a wallet's irreversible actions; on mobile the one
 * that matters is Reset wallet. Everything about this screen is shaped by that:
 *
 *   • It is reachable on BOTH networks. The old reset lived in the testnet-only
 *     Developer group, so a mainnet user (real funds) had no supported way to
 *     start over.
 *   • The reset cannot happen from a single tap. The user must type the word and
 *     tick the acknowledgement before the button unlocks.
 *   • Before the destructive control is even enabled, the screen offers a backup
 *     and states plainly what is lost and what survives.
 *
 * It does NOT sign anything. Reset only deletes local state, so the signing
 * ceremony in lib/walletConnect.ts is untouched.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';

import { useWallet } from '../../components/WalletProvider';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';
import { getNetworkName, subscribeToNetwork } from '../../lib/network';
import { getWalletAddress, resetWallet } from '../../lib/walletStore';

/** The word the user must type before the reset button unlocks. */
export const CONFIRM_WORD = 'RESET';

/** Shorten a wallet address for display without ever hiding which wallet it is. */
function shorten(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-8)}` : address;
}

export default function DangerZoneScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { clearSession } = useWallet();

  const networkName = useSyncExternalStore(subscribeToNetwork, getNetworkName, getNetworkName);
  const onTestnet = networkName === 'testnet';

  const [address, setAddress] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getWalletAddress().then((value) => {
      if (active) setAddress(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const canReset = confirmText === CONFIRM_WORD && acknowledged && !resetting;

  async function handleReset() {
    if (!canReset) return;
    setResetting(true);
    setError(null);
    try {
      // Drop the in-memory signer session first, then wipe the persisted wallet
      // and every cached trace of it. Either half alone leaves a wallet that
      // looks reset but can still spend.
      clearSession();
      await resetWallet();
      router.replace('/welcome');
    } catch (err) {
      setResetting(false);
      setError(
        err instanceof Error
          ? `Could not fully reset: ${err.message}`
          : 'Could not fully reset the wallet. Nothing was sent on-chain; try again.'
      );
    }
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      testID="danger-screen"
    >
      <Text style={styles.title}>Danger zone</Text>
      <Text style={styles.subtitle}>
        Irreversible actions for {onTestnet ? 'your testnet wallet' : 'your MAINNET wallet'}.
      </Text>

      {/* What a reset does, stated before anything destructive is offered. */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>What a reset removes</Text>
        <Text style={styles.cardBody}>
          This device’s wallet on the {networkName} network: its address, its passkey credential
          and its fee-payer signing key, plus the cached state derived from it — pending
          transactions, connected apps, balances and activity.
        </Text>
        {address && (
          <Text style={styles.address} accessibilityLabel={`Wallet ${address}`}>
            {shorten(address)}
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>What is kept</Text>
        <Text style={styles.cardBody}>
          Your wallet on the other network, your display and notification preferences, and any
          backup you have already exported. Funds stay on-chain — but without a backup this
          device will no longer be able to reach them.
        </Text>
      </View>

      {/* Backup first. The destructive control below stays disabled until the
          acknowledgement is ticked, so this is offered before it can be used. */}
      <View style={[styles.card, styles.backupCard]}>
        <Text style={styles.cardTitle}>Back up before you reset</Text>
        <Text style={styles.cardBody}>
          A backup lets you restore this wallet on this or another device. It takes about a
          minute and is the difference between starting over and losing access for good.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back up wallet"
          onPress={() => router.push('/settings/backup')}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryLabel}>Back up wallet</Text>
        </Pressable>
      </View>

      <View style={[styles.card, styles.destructiveCard]}>
        <Text style={styles.destructiveTitle}>Reset wallet</Text>
        <Text style={styles.cardBody}>
          Type <Text style={styles.mono}>{CONFIRM_WORD}</Text> to confirm, then acknowledge that
          this cannot be undone.
        </Text>

        <TextInput
          style={styles.input}
          placeholder={CONFIRM_WORD}
          placeholderTextColor={colors.textFaint}
          value={confirmText}
          onChangeText={setConfirmText}
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!resetting}
          accessibilityLabel={`Type ${CONFIRM_WORD} to confirm the reset`}
        />

        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: acknowledged }}
          onPress={() => setAcknowledged((value) => !value)}
          style={styles.checkboxRow}
        >
          <View style={[styles.checkbox, acknowledged && styles.checkboxChecked]}>
            {acknowledged && <Text style={styles.checkboxTick}>✓</Text>}
          </View>
          <Text style={styles.checkboxLabel}>
            I understand that this action is irreversible and this wallet will be permanently
            removed from this device.
          </Text>
        </Pressable>

        {error && <Text style={styles.error}>{error}</Text>}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset wallet permanently"
          accessibilityState={{ disabled: !canReset }}
          disabled={!canReset}
          onPress={handleReset}
          style={({ pressed }) => [
            styles.dangerButton,
            !canReset && styles.dangerButtonDisabled,
            pressed && canReset && styles.pressed,
          ]}
        >
          {resetting ? (
            <ActivityIndicator color={colors.textStrong} />
          ) : (
            <Text style={styles.dangerLabel}>Reset wallet</Text>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: {
      backgroundColor: colors.background,
      flex: 1,
    },
    content: {
      gap: 16,
      padding: 24,
      paddingBottom: 48,
    },
    title: {
      color: colors.danger,
      fontFamily: fontFamily.heading,
      fontSize: 28,
    },
    subtitle: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14,
      lineHeight: 20,
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: 1,
      gap: 8,
      padding: 16,
    },
    backupCard: {
      borderColor: colors.accent,
    },
    destructiveCard: {
      backgroundColor: colors.dangerSurface,
      borderColor: colors.danger,
    },
    cardTitle: {
      color: colors.textStrong,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    cardBody: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    destructiveTitle: {
      color: colors.danger,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    address: {
      color: colors.accentText,
      fontFamily: fontFamily.address,
      fontSize: 12,
    },
    mono: {
      color: colors.textStrong,
      fontFamily: fontFamily.address,
      fontWeight: '700',
    },
    input: {
      backgroundColor: colors.surfaceMd,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: 1,
      color: colors.textPrimary,
      fontFamily: fontFamily.address,
      fontSize: 16,
      letterSpacing: 2,
      marginTop: 4,
      padding: 14,
    },
    checkboxRow: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: 12,
      marginTop: 4,
    },
    checkbox: {
      alignItems: 'center',
      borderColor: colors.border,
      borderRadius: 6,
      borderWidth: 1,
      height: 22,
      justifyContent: 'center',
      marginTop: 1,
      width: 22,
    },
    checkboxChecked: {
      backgroundColor: colors.danger,
      borderColor: colors.danger,
    },
    checkboxTick: {
      color: colors.textStrong,
      fontSize: 14,
      fontWeight: '700',
    },
    checkboxLabel: {
      color: colors.textPrimary,
      flex: 1,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    error: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    secondaryButton: {
      alignItems: 'center',
      borderColor: colors.accent,
      borderRadius: 10,
      borderWidth: 1,
      justifyContent: 'center',
      marginTop: 4,
      minHeight: 48,
      paddingVertical: 14,
    },
    secondaryLabel: {
      color: colors.accentText,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    dangerButton: {
      alignItems: 'center',
      backgroundColor: colors.danger,
      borderRadius: 10,
      justifyContent: 'center',
      marginTop: 8,
      minHeight: 48,
      paddingVertical: 14,
    },
    dangerButtonDisabled: {
      opacity: 0.4,
    },
    dangerLabel: {
      color: colors.textStrong,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 15,
    },
    pressed: {
      opacity: 0.7,
    },
  });
