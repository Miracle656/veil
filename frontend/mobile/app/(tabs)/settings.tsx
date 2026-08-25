import { useMemo, useState, useSyncExternalStore } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { useTheme } from '../../hooks/useTheme';
import { useCurrency } from '../../hooks/useCurrency';
import { CURRENCIES, CURRENCY_CODES } from '../../lib/currency';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';
import { getNetwork, getNetworkName, setNetwork, subscribeToNetwork } from '../../lib/network';
import { getWalletAddress, clearWalletStore } from '../../lib/walletStore';
import { getFeePayerAddress } from '../../lib/activity';
import { fundWithFriendbot } from '../../lib/testnetWallet';

type Row = {
  key: string;
  title: string;
  subtitle: string;
  value?: string;
  onPress: () => void;
  /** Render a Switch on the right instead of value/chevron. */
  switch?: { value: boolean; onChange: (v: boolean) => void };
};

export default function SettingsScreen() {
  const router = useRouter();
  const { colors, isDark, toggle } = useTheme();
  const { currency, meta, select } = useCurrency();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [currencyPickerOpen, setCurrencyPickerOpen] = useState(false);

  const appearance: Row[] = [
    {
      key: 'theme',
      title: 'Appearance',
      subtitle: 'Light or dark',
      value: isDark ? 'Dark' : 'Light',
      onPress: toggle,
    },
    {
      key: 'currency',
      title: 'Display currency',
      subtitle: 'Tap your balance card to flip between crypto and this',
      value: `${meta.symbol} ${currency}`,
      onPress: () => setCurrencyPickerOpen(true),
    },
  ];

  const security: Row[] = [
    { key: 'passkeys', title: 'Passkeys', subtitle: 'Devices registered on this wallet', onPress: () => {} },
    { key: 'recovery', title: 'Recovery', subtitle: 'Trusted servers to recover access', onPress: () => router.push('/recover') },
    { key: 'lock', title: 'Security & lock', subtitle: 'Auto-lock after inactivity', onPress: () => router.push('/settings/security') },
  ];

  // Live network name (re-renders when the override changes).
  const networkName = useSyncExternalStore(subscribeToNetwork, getNetworkName, getNetworkName);
  const onTestnet = networkName === 'testnet';

  const handleNetworkToggle = (toMainnet: boolean) => {
    const target = toMainnet ? 'mainnet' : 'testnet';
    Alert.alert(
      toMainnet ? 'Switch to Mainnet?' : 'Switch to Testnet?',
      toMainnet
        ? 'Mainnet uses REAL funds. Your wallet, balances, and history are separate per network. Fully close and reopen the app after switching so every connection uses the new network.'
        : 'Back to test funds. Fully close and reopen the app after switching.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Switch',
          style: toMainnet ? 'destructive' : 'default',
          onPress: () => {
            void setNetwork(target).then(() =>
              Alert.alert('Network switched', `Now on ${target}. Close and reopen the app to finish.`),
            );
          },
        },
      ],
    );
  };

  const general: Row[] = [
    {
      key: 'network',
      title: 'Mainnet',
      subtitle: onTestnet ? 'Off — using Stellar testnet (test funds)' : 'On — REAL funds on Stellar mainnet',
      onPress: () => handleNetworkToggle(onTestnet),
      switch: { value: !onTestnet, onChange: (v) => handleNetworkToggle(v) },
    },
    { key: 'multisig', title: 'Multisig', subtitle: 'View signers and approval threshold', onPress: () => router.push('/multisig') },
    { key: 'contacts', title: 'Address book', subtitle: 'Saved recipients and labels', onPress: () => router.push('/contacts') },
    { key: 'about', title: 'About', subtitle: 'Version, licenses, and support', onPress: () => {} },
  ];
  const fundTestXlm = async () => {
    const address = await getWalletAddress();
    if (!address) {
      Alert.alert('No wallet', 'Create a wallet first.');
      return;
    }
    // Smart (C…) wallet: fund BOTH sides — the fee-payer G-account (classic
    // spends + fees) and the contract itself (Friendbot supports contract
    // addresses via SAC transfer; contract funds exercise __check_auth).
    if (address.startsWith('C')) {
      const feePayer = await getFeePayerAddress();
      if (!feePayer) {
        Alert.alert('No fee-payer key', 'This wallet has no fee-payer key on the device.');
        return;
      }
      const [fpOk, cOk] = await Promise.all([fundWithFriendbot(feePayer), fundWithFriendbot(address)]);
      Alert.alert(
        fpOk || cOk ? 'Funded' : 'Funding failed',
        fpOk && cOk
          ? 'Test XLM sent to your fee-payer and your smart wallet.'
          : fpOk
            ? 'Fee-payer funded; the smart wallet top-up was rejected (it may be rate-limited).'
            : cOk
              ? 'Smart wallet funded; the fee-payer top-up was rejected (it may be rate-limited).'
              : 'Friendbot rejected both requests. Try again in a moment.',
      );
      return;
    }
    const ok = await fundWithFriendbot(address);
    Alert.alert(
      ok ? 'Funded' : 'Funding failed',
      ok
        ? `Test XLM is on its way to ${address.slice(0, 4)}…${address.slice(-4)}.`
        : 'Friendbot rejected the request. Try again in a moment.',
    );
  };
  const resetWallet = () => {
    Alert.alert(
      'Reset wallet?',
      'Removes the wallet key from this device so you can create a fresh testnet wallet. Back up your secret first if you need it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            await clearWalletStore();
            router.replace('/welcome');
          },
        },
      ],
    );
  };
  const developer: Row[] = [
    { key: 'fund', title: 'Fund test XLM', subtitle: 'Top up this wallet from Friendbot', value: 'Testnet', onPress: fundTestXlm },
    { key: 'reset', title: 'Reset wallet', subtitle: 'Clear this wallet and start fresh', onPress: resetWallet },
  ];

  const group = (heading: string, rows: Row[]) => (
    <View style={styles.group}>
      <Text style={styles.groupHeading}>{heading}</Text>
      <View style={styles.card}>
        {rows.map((row, i) => (
          <Pressable
            key={row.key}
            onPress={row.onPress}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, i > 0 && styles.rowDivider, pressed && styles.pressed]}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{row.title}</Text>
              <Text style={styles.rowSubtitle}>{row.subtitle}</Text>
            </View>
            {row.switch ? (
              <Switch
                value={row.switch.value}
                onValueChange={row.switch.onChange}
                trackColor={{ false: colors.surfaceMd, true: 'rgba(253,218,36,0.45)' }}
                thumbColor={row.switch.value ? colors.accent : colors.textFaint}
              />
            ) : (
              <>
                {row.value ? <Text style={styles.rowValue}>{row.value}</Text> : null}
                <Text style={styles.chevron}>›</Text>
              </>
            )}
          </Pressable>
        ))}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="settings-screen">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

        {group('Appearance', appearance)}
        {group('Security', security)}
        {group('General', general)}
        {onTestnet && group('Developer', developer)}
      </ScrollView>

      <Modal visible={currencyPickerOpen} transparent animationType="fade" onRequestClose={() => setCurrencyPickerOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setCurrencyPickerOpen(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF' }]} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Display currency</Text>
            {CURRENCY_CODES.map((code) => {
              const c = CURRENCIES[code];
              const selected = code === currency;
              return (
                <Pressable
                  key={code}
                  onPress={() => { select(code); setCurrencyPickerOpen(false); }}
                  style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
                >
                  <Text style={[styles.sheetSymbol, selected && styles.sheetSelected]}>{c.symbol}</Text>
                  <Text style={[styles.sheetName, selected && styles.sheetSelected]}>{c.label}</Text>
                  <Text style={styles.sheetCode}>{selected ? '✓' : code}</Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    content: { padding: 20, paddingBottom: 130, gap: 20 },
    title: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 28, marginTop: 8 },
    group: { gap: 8 },
    groupHeading: {
      color: colors.label,
      fontFamily: fontFamily.accent,
      fontSize: 11,
      letterSpacing: 1,
      textTransform: 'uppercase',
      marginLeft: 4,
    },
    card: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 16,
      overflow: 'hidden',
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 16, paddingHorizontal: 16 },
    rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
    rowText: { flex: 1 },
    rowTitle: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 15 },
    rowSubtitle: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 12, lineHeight: 17, marginTop: 3 },
    rowValue: { color: colors.accent, fontFamily: fontFamily.bodyMedium, fontSize: 14 },
    chevron: { color: colors.textFaint, fontSize: 20 },
    pressed: { opacity: 0.6 },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: colors.surfaceMd, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 40 },
    sheetTitle: { color: colors.textFaint, fontFamily: fontFamily.bodySemiBold, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8 },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
    sheetSymbol: { color: colors.textSecondary, fontFamily: fontFamily.bodySemiBold, fontSize: 16, width: 28 },
    sheetName: { flex: 1, color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 15 },
    sheetCode: { color: colors.textFaint, fontFamily: fontFamily.address, fontSize: 13 },
    sheetSelected: { color: colors.accent },
  });
