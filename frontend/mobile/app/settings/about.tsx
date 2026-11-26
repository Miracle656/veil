/**
 * About — which build is installed, whether it is the latest, and where to get
 * help.
 *
 * The Settings row for this existed with an empty handler, so tapping it did
 * nothing. Testers asked for two things by name: a way to tell whether they are
 * on the latest build, and a link to download it. Both are here, backed by the
 * GitHub Releases the APK workflow publishes (lib/appUpdate.ts).
 *
 * Everything else on the screen is derived at render from lib/about.ts, so it
 * cannot drift from what the app is actually running.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';

import { useNetwork } from '../../hooks/useNetwork';
import { useTheme } from '../../hooks/useTheme';
import {
  EXTERNAL_LINKS,
  explorerAddressUrl,
  getAppVersion,
  getContractEntries,
  getNetworkFacts,
  openExternalUrl,
} from '../../lib/about';
import { checkForUpdate, type UpdateCheck } from '../../lib/appUpdate';
import { redactEndpoint } from '../../lib/redactEndpoint';
import type { ThemeColors } from '../../lib/theme';
import { getWalletAddress } from '../../lib/walletStore';
import { fontFamily, typography } from '../../theme/typography';

function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

export default function AboutScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { network } = useNetwork();

  const { version, build } = getAppVersion();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    void getWalletAddress()
      .then((address) => alive && setWalletAddress(address))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const runCheck = useCallback(async (force: boolean) => {
    setChecking(true);
    try {
      setUpdate(await checkForUpdate(force));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runCheck(false);
  }, [runCheck]);

  const facts = getNetworkFacts(network);
  const contracts = getContractEntries(walletAddress, network);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <FlowHeader title="About" />
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.version}>Veil {version}</Text>
        <Text style={styles.hint}>{build ? `Build ${build}` : 'Development build'}</Text>

        {checking ? (
          <View style={styles.row}>
            <ActivityIndicator color={colors.accent} size="small" />
            <Text style={styles.hint}>Checking for updates…</Text>
          </View>
        ) : update?.state === 'current' ? (
          <Text style={[styles.status, styles.good]}>You&apos;re on the latest build ✓</Text>
        ) : update?.state === 'update' ? (
          <>
            <Text style={[styles.status, styles.accent]}>
              Update available — build {update.latest.versionCode}
            </Text>
            <DownloadApk url={update.latest.url} styles={styles} />
          </>
        ) : (
          // `unknown` still carries the newest release when GitHub answered, so
          // the download stays reachable. What it must not do is call it an
          // update, because there is nothing to compare it against.
          <>
            <Text style={styles.hint}>{update?.reason ?? 'Could not check for updates.'}</Text>
            {update?.state === 'unknown' && update.latest && (
              <>
                <Text style={styles.hint}>Newest published build: {update.latest.versionCode}</Text>
                <DownloadApk url={update.latest.url} styles={styles} />
              </>
            )}
          </>
        )}

        <Pressable
          accessibilityRole="button"
          disabled={checking}
          onPress={() => void runCheck(true)}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryText}>Check again</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionLabel}>NETWORK</Text>
      <View style={styles.card}>
        {facts.map((fact) => (
          <View key={fact.key} style={styles.factRow}>
            <Text style={styles.factLabel}>{fact.label}</Text>
            {/* Redacted: an RPC URL can carry an account key in its path. */}
            <Text style={styles.factValue}>{redactEndpoint(fact.value)}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.sectionLabel}>CONTRACTS</Text>
      <View style={styles.card}>
        {contracts.map((entry) => {
          const url = explorerAddressUrl(entry.address, network);
          return (
            <Pressable
              key={entry.key}
              accessibilityRole={url ? 'link' : undefined}
              disabled={!url}
              onPress={() => url && void openExternalUrl(url)}
              style={styles.factRow}
            >
              <Text style={styles.factLabel}>{entry.label}</Text>
              <Text style={[styles.mono, url && styles.linked]}>
                {entry.address ? shortAddress(entry.address) : 'Not configured'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.sectionLabel}>HELP &amp; LICENCES</Text>
      <View style={styles.card}>
        {EXTERNAL_LINKS.map((link) => (
          <Pressable
            key={link.key}
            accessibilityRole="link"
            onPress={() => void openExternalUrl(link.url)}
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
          >
            <View style={styles.linkText}>
              <Text style={styles.linkLabel}>{link.label}</Text>
              <Text style={styles.hint}>{link.description}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.footnote}>
        Veil is open source under the MIT licence. The wallet contracts run on Stellar; your passkey
        stays on this device.
      </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * The download button, shared by the two states that can offer one: a confirmed
 * update, and a check that could not compare builds but did find a release.
 */
function DownloadApk({ url, styles }: { url: string; styles: ReturnType<typeof createStyles> }) {
  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={() => void openExternalUrl(url)}
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
      >
        <Text style={styles.primaryText}>Download the latest APK</Text>
      </Pressable>
      <Text style={styles.hint}>It installs over this one — your wallet and passkey stay as they are.</Text>
    </>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    header: { paddingHorizontal: 20, paddingTop: 16 },
    content: { padding: 20, paddingBottom: 48, gap: 14 },
    sectionLabel: {
      ...typography.accent,
      color: colors.textMuted,
      fontSize: 11,
      marginTop: 10,
    },
    card: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 16,
      padding: 18,
      gap: 10,
    },
    version: { ...typography.heading, fontSize: 22, color: colors.textStrong },
    status: { fontFamily: fontFamily.bodySemiBold, fontSize: 14 },
    good: { color: colors.positive },
    accent: { color: colors.accentText },
    hint: { fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19, color: colors.textMuted },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    factRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
    },
    factLabel: { fontFamily: fontFamily.body, fontSize: 13, color: colors.textMuted },
    factValue: {
      fontFamily: fontFamily.body,
      fontSize: 13,
      color: colors.textPrimary,
      flexShrink: 1,
      textAlign: 'right',
    },
    mono: { fontFamily: fontFamily.address, fontSize: 13, color: colors.textPrimary },
    linked: { color: colors.accentText },
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      paddingVertical: 6,
    },
    linkText: { flex: 1, gap: 2 },
    linkLabel: { fontFamily: fontFamily.bodyMedium, fontSize: 15, color: colors.textPrimary },
    chevron: { fontFamily: fontFamily.body, fontSize: 20, color: colors.textFaint },
    primary: {
      marginTop: 4,
      alignItems: 'center',
      paddingVertical: 13,
      borderRadius: 100,
      backgroundColor: colors.accent,
    },
    primaryText: { fontFamily: fontFamily.bodySemiBold, fontSize: 15, color: colors.onAccent },
    secondary: {
      alignItems: 'center',
      paddingVertical: 11,
      borderRadius: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    secondaryText: { fontFamily: fontFamily.bodyMedium, fontSize: 14, color: colors.textPrimary },
    pressed: { opacity: 0.7 },
    footnote: {
      fontFamily: fontFamily.body,
      fontSize: 12,
      lineHeight: 18,
      color: colors.textFaint,
      marginTop: 6,
    },
  });
