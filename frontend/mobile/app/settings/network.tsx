import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';
import { requirePasskey } from '../../lib/passkey';
import { useRouter } from 'expo-router';

import { fontFamily } from '../../theme/typography';
import { useTheme } from '../../hooks/useTheme';
import type { ThemeColors } from '../../lib/theme';
import { useNetwork } from '../../hooks/useNetwork';
import {
  getPasskeyId,
  getPasskeyPublicKey,
  getSignerSecret,
  getWalletAddress,
  hasUsableWallet,
} from '../../lib/walletStore';
import {
  NETWORKS,
  NETWORK_NAMES,
  describeMissingConfig,
  getBuildTimeNetworkName,
  isNetworkConfigured,
  type VeilNetworkName,
} from '../../lib/network';

export default function NetworkScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { network, networkName, switchNetwork, isSwitching, error } = useNetwork();
  const buildDefault = getBuildTimeNetworkName();
  const missing = describeMissingConfig(network);

  // Wallets are namespaced per network on purpose (see lib/walletStore.ts): a
  // reset on testnet must not be able to destroy a real-funds mainnet wallet.
  // The cost is that switching can land you on a network where you have no
  // wallet at all — and until now nothing said so. You found out later, at the
  // point of spending, as "No passkey found on this device".
  //
  // Both halves are checked, not just the address: an address can be present
  // with no credential behind it, and that is the shape that actually bit —
  // the swap failed with "No passkey found on this device", not with a missing
  // wallet. Checking the address alone would have stayed silent for it.
  const [hasWallet, setHasWallet] = useState<boolean | null>(null);
  // What is actually stored for THIS network. Presence only — never the values.
  // "No passkey found on this device" at the moment of a swap says nothing
  // about which of the four pieces is missing, and the pieces are written
  // independently, so this is the one place that can answer it.
  const [parts, setParts] = useState<Record<string, boolean> | null>(null);

  // Storage presence cannot prove a credential still resolves: a passkey is
  // bound to the relying party it was created against, so an id can be stored
  // while the OS holds nothing matching it. Only an assertion settles it.
  const [probe, setProbe] = useState<'idle' | 'running' | 'ok' | string>('idle');
  const testPasskey = async () => {
    setProbe('running');
    try {
      await requirePasskey();
      setProbe('ok');
    } catch (err) {
      setProbe(err instanceof Error ? err.message : 'Passkey check failed.');
    }
  };

  useEffect(() => {
    let alive = true;
    setHasWallet(null);
    setParts(null);
    setProbe('idle');
    Promise.all([
      hasUsableWallet(),
      getWalletAddress().catch(() => null),
      getPasskeyId().catch(() => null),
      getPasskeyPublicKey().catch(() => null),
      getSignerSecret().catch(() => null),
    ])
      .then(([ok, address, keyId, publicKey, signer]) => {
        if (!alive) return;
        setHasWallet(ok);
        setParts({
          'Wallet address': !!address,
          'Passkey credential': !!keyId,
          'Passkey public key': !!publicKey,
          'Signer key': !!signer,
        });
      })
      .catch(() => { if (alive) setHasWallet(false); });
    return () => { alive = false; };
  }, [networkName, isSwitching]);

  return (
    // SafeAreaView + FlowHeader, matching app/transactions.tsx. Pushed screens
    // render with headerShown:false, so without the top inset the title sat
    // under the status bar — and without the header there was no back affordance
    // beyond the system gesture.
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="Network" />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.container}>
      <Text style={styles.subtitle}>
        Choose which Stellar network this app talks to. The choice is remembered across restarts.
      </Text>

      <View style={styles.options}>
        {NETWORK_NAMES.map((name) => (
          <NetworkOption
            key={name}
            name={name}
            selected={name === networkName}
            isDefault={name === buildDefault}
            disabled={isSwitching}
            onPress={() => switchNetwork(name)}
          />
        ))}
      </View>

      {isSwitching && (
        <View style={styles.switchingRow}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.hint}>Switching network and reloading wallet state.</Text>
        </View>
      )}

      {hasWallet === false && !isSwitching && (
        <View style={styles.warningCard}>
          <Text style={styles.warningTitle}>No wallet on {network.displayName}</Text>
          <Text style={styles.cardBody}>
            Each network keeps its own wallet, so a reset on one can never touch the
            other. This device has no {network.displayName} wallet yet — create or
            recover one before sending, swapping or earning here. Your wallets on
            other networks are unaffected.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/create-wallet')}
            style={styles.walletAction}
          >
            <Text style={styles.walletActionText}>Create a {network.displayName} wallet</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push('/recover')}
            style={styles.walletActionGhost}
          >
            <Text style={styles.walletActionGhostText}>Recover an existing one</Text>
          </Pressable>
        </View>
      )}

      {parts && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Wallet on {network.displayName}</Text>
          {Object.entries(parts).map(([label, present]) => (
            <View key={label} style={styles.checkRow}>
              <Text style={[styles.checkMark, present ? styles.checkYes : styles.checkNo]}>
                {present ? '✓' : '✕'}
              </Text>
              <Text style={styles.checkLabel}>{label}</Text>
            </View>
          ))}
          <Text style={styles.cardBody}>
            Ticks mean the values are stored, not that the device still holds the
            passkey — a credential is bound to the domain it was created against.
            Run the check to find out for certain.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={testPasskey}
            disabled={probe === 'running'}
            style={styles.walletActionGhost}
          >
            <Text style={styles.walletActionGhostText}>
              {probe === 'running' ? 'Waiting for passkey…' : 'Test passkey'}
            </Text>
          </Pressable>
          {probe === 'ok' && (
            <Text style={[styles.cardBody, styles.probeOk]}>
              Passkey works on this device.
            </Text>
          )}
          {probe !== 'idle' && probe !== 'running' && probe !== 'ok' && (
            <Text style={[styles.cardBody, styles.probeFail]}>{probe}</Text>
          )}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Active endpoints</Text>
        <Detail label="Soroban RPC" value={redactEndpoint(network.rpcUrl)} />
        <Detail label="Horizon" value={network.horizonUrl} />
        <Detail label="Factory contract" value={network.factoryContractId} />
        <Detail label="Passphrase" value={network.networkPassphrase} />
      </View>

      {missing.length > 0 && (
        <View style={styles.warningCard}>
          <Text style={styles.warningTitle}>{network.displayName} is not configured</Text>
          <Text style={styles.cardBody}>
            This build has no {missing.join(' and ')} for {network.displayName}. Requests will fail
            until the matching EXPO_PUBLIC_ values are set. Switch back to{' '}
            {NETWORKS[buildDefault].displayName} to keep using the app.
          </Text>
        </View>
      )}

        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

function NetworkOption({
  name,
  selected,
  isDefault,
  disabled,
  onPress,
}: {
  name: VeilNetworkName;
  selected: boolean;
  isDefault: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const network = NETWORKS[name];
  const configured = isNetworkConfigured(network);

  return (
    <Pressable
      style={[styles.option, selected && styles.optionSelected]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={`Use ${network.displayName}`}
    >
      <View style={styles.optionText}>
        <Text style={styles.optionTitle}>{network.displayName}</Text>
        <Text style={styles.optionSubtitle}>
          {configured ? redactEndpoint(network.rpcUrl) : 'Not configured in this build'}
          {isDefault ? ' · build default' : ''}
        </Text>
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]} />
    </Pressable>
  );
}

/**
 * Show an endpoint without showing its credential.
 *
 * Provider RPC URLs carry the API key in the path — QuickNode's is the hex
 * segment after the host — so printing the URL verbatim puts a working key on
 * screen, in screenshots, and in any screen recording. The host is the useful
 * part for a human checking which provider is live; the rest is a secret and is
 * masked.
 *
 * This is defence in depth, not a fix for the underlying exposure: anything in
 * an EXPO_PUBLIC_ variable ships inside the bundle and can be extracted from
 * the APK. The real protection is a key scoped to read-only RPC and rotated
 * when leaked.
 */
function redactEndpoint(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/|\/$/g, '');
    if (!path) return `${parsed.protocol}//${parsed.host}`;
    return `${parsed.protocol}//${parsed.host}/${'•'.repeat(8)}`;
  } catch {
    // Not a parseable URL — show nothing rather than risk showing a secret.
    return '(set)';
  }
}

function Detail({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={2}>
        {value || 'not set'}
      </Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Matches app/(tabs)/settings.tsx: same fonts, radii, card treatment and
    // uppercase group headings. This screen predated the design system and was
    // the only one still on raw fontWeight/fontSize, which is why it read as a
    // different app sitting next to Settings and Transactions.
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    container: { flexGrow: 1, padding: 20, paddingBottom: 60, gap: 20 },
    subtitle: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },

    options: { gap: 10 },
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
    },
    optionSelected: { borderColor: colors.accent, backgroundColor: colors.surfaceMd },
    optionText: { flex: 1, gap: 3 },
    optionTitle: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 15 },
    optionSubtitle: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 12, lineHeight: 17 },
    radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.border },
    radioSelected: { borderColor: colors.accent, backgroundColor: colors.accent },

    switchingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },

    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
      gap: 12,
    },
    cardTitle: {
      color: colors.label,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1,
      textTransform: 'uppercase',
    },
    cardBody: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },

    detailRow: { gap: 3 },
    detailLabel: {
      color: colors.textFaint,
      fontFamily: fontFamily.accent,
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    detailValue: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 12, lineHeight: 17 },

    warningCard: {
      backgroundColor: colors.surfaceMd,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.accent,
      padding: 16,
      gap: 10,
    },
    warningTitle: { color: colors.accentText, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    walletAction: {
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: colors.accent,
      alignItems: 'center',
    },
    walletActionText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },
    walletActionGhost: {
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
    },
    walletActionGhostText: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 14 },

    checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    checkMark: { fontFamily: fontFamily.bodySemiBold, fontSize: 14, width: 16 },
    checkYes: { color: colors.positive },
    checkNo: { color: colors.danger },
    checkLabel: { color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 13 },
    probeOk: { color: colors.positive },
    probeFail: { color: colors.danger },
    hint: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 13 },
    error: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
  });
