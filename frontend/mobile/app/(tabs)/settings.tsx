import { useMemo, useState, useSyncExternalStore } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { useTheme } from '../../hooks/useTheme';
import { useCurrency } from '../../hooks/useCurrency';
import { CURRENCIES, CURRENCY_CODES } from '../../lib/currency';
import type { ThemeColors, ThemePreference } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';
import {
  getNetwork,
  getNetworkName,
  setNetwork,
  subscribeToNetwork,
  type VeilNetworkName,
} from '../../lib/network';
import { ConfirmModal } from '../../components/ConfirmModal';
import { NoticeModal } from '../../components/NoticeModal';
import { getWalletAddress, hasUsableWallet, clearWalletStore } from '../../lib/walletStore';
import { getFeePayerAddress } from '../../lib/activity';
import { fundWithFriendbot } from '../../lib/testnetWallet';
import {
  getNotifIncoming,
  getNotifOutgoing,
  isNotifPrefsHydrated,
  subscribeToNotifPrefs,
  setNotifIncoming,
  setNotifOutgoing,
} from '../../lib/notificationPrefs';
import { requestNotificationPermissions } from '../../lib/notifications';

type Row = {
  key: string;
  title: string;
  subtitle: string;
  value?: string;
  onPress: () => void;
  /** Render a Switch on the right instead of value/chevron. */
  switch?: { value: boolean; onChange: (v: boolean) => void };
};

/** The three appearance choices, in the order they are offered. */
const THEME_OPTIONS: { value: ThemePreference; label: string; glyph: string }[] = [
  { value: 'system', label: 'Follow device', glyph: '◐' },
  { value: 'light', label: 'Light', glyph: '☀' },
  { value: 'dark', label: 'Dark', glyph: '☾' },
];

export default function SettingsScreen() {
  const router = useRouter();
  const { colors, isDark, preference, systemTheme, select: selectTheme } = useTheme();
  const { currency, meta, select } = useCurrency();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [currencyPickerOpen, setCurrencyPickerOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);

  const appearance: Row[] = [
    {
      key: 'theme',
      title: 'Appearance',
      subtitle: 'Light, dark, or follow your device',
      // On 'system', show what it currently resolves to as well — "System"
      // alone leaves the user guessing which one they are actually looking at.
      value:
        preference === 'system'
          ? `System · ${systemTheme === 'dark' ? 'Dark' : 'Light'}`
          : preference === 'dark'
            ? 'Dark'
            : 'Light',
      onPress: () => setThemePickerOpen(true),
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

  // Live notification preferences.
  const notifIncoming = useSyncExternalStore(subscribeToNotifPrefs, getNotifIncoming, getNotifIncoming);
  const notifOutgoing = useSyncExternalStore(subscribeToNotifPrefs, getNotifOutgoing, getNotifOutgoing);

  const notifications: Row[] = [
    {
      key: 'notif-incoming',
      title: 'Incoming transfers',
      subtitle: 'Notify when you receive a payment',
      onPress: () => {
        void requestNotificationPermissions().then((granted) => {
          if (!granted) {
            setNotice({ title: 'Notifications off', message: 'Enable notifications in your device settings to receive alerts.', tone: 'neutral' });
          } else {
            void setNotifIncoming(!notifIncoming);
          }
        });
      },
      switch: { value: notifIncoming, onChange: (v) => {
        void requestNotificationPermissions().then((granted) => {
          if (!granted) {
            setNotice({ title: 'Notifications off', message: 'Enable notifications in your device settings to receive alerts.', tone: 'neutral' });
          } else {
            void setNotifIncoming(v);
          }
        });
      } },
    },
    {
      key: 'notif-outgoing',
      title: 'Outgoing confirmations',
      subtitle: 'Notify when a sent transaction confirms',
      onPress: () => void setNotifOutgoing(!notifOutgoing),
      switch: { value: notifOutgoing, onChange: (v) => void setNotifOutgoing(v) },
    },
  ];

  // Live network name (re-renders when the override changes).
  const networkName = useSyncExternalStore(subscribeToNetwork, getNetworkName, getNetworkName);
  const onTestnet = networkName === 'testnet';

  // Which network the user is being asked to switch to, or null when the
  // sheet is closed. A themed sheet rather than Alert.alert: switching to
  // mainnet puts real money at risk, and that warning deserves to look like
  // part of the wallet rather than a grey OS box.
  const [pendingNetwork, setPendingNetwork] = useState<VeilNetworkName | null>(null);
  const [switchedTo, setSwitchedTo] = useState<VeilNetworkName | null>(null);
  const [switchedHasWallet, setSwitchedHasWallet] = useState(true);

  const handleNetworkToggle = (toMainnet: boolean) => {
    setPendingNetwork(toMainnet ? 'mainnet' : 'testnet');
  };

  const confirmNetworkSwitch = () => {
    const target = pendingNetwork;
    setPendingNetwork(null);
    if (!target) return;
    void setNetwork(target).then(async () => {
      // Wallets are namespaced per network (lib/walletStore.ts) so a reset on
      // one can never destroy the other. The cost is that a switch can land on
      // a network with no wallet at all, and saying nothing here meant the user
      // discovered it later, mid-send, as "No passkey found on this device".
      // Uses the same readiness test the spend path enforces, so this cannot
      // quietly pass while a swap still fails.
      setSwitchedHasWallet(await hasUsableWallet());
      setSwitchedTo(target);
    });
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
  // NoticeModal rather than Alert.alert: these report an outcome, and the
  // platform dialog renders "Funded" and "Funding failed" identically.
  const [notice, setNotice] = useState<
    { title: string; message: string; tone: 'neutral' | 'success' | 'error' } | null
  >(null);

  const fundTestXlm = async () => {
    const address = await getWalletAddress();
    if (!address) {
      setNotice({ title: 'No wallet', message: 'Create a wallet first.', tone: 'error' });
      return;
    }
    // Smart (C…) wallet: fund BOTH sides — the fee-payer G-account (classic
    // spends + fees) and the contract itself (Friendbot supports contract
    // addresses via SAC transfer; contract funds exercise __check_auth).
    if (address.startsWith('C')) {
      const feePayer = await getFeePayerAddress();
      if (!feePayer) {
        setNotice({
          title: 'No fee-payer key',
          message: 'This wallet has no fee-payer key on the device.',
          tone: 'error',
        });
        return;
      }
      const [fpOk, cOk] = await Promise.all([fundWithFriendbot(feePayer), fundWithFriendbot(address)]);
      setNotice({
        title: fpOk || cOk ? 'Funded' : 'Funding failed',
        tone: fpOk && cOk ? 'success' : fpOk || cOk ? 'neutral' : 'error',
        message:
          fpOk && cOk
            ? 'Test XLM sent to your fee-payer and your smart wallet.'
            : fpOk
              ? 'Fee-payer funded; the smart wallet top-up was rejected (it may be rate-limited).'
              : cOk
                ? 'Smart wallet funded; the fee-payer top-up was rejected (it may be rate-limited).'
                : 'Friendbot rejected both requests. Try again in a moment.',
      });
      return;
    }
    const ok = await fundWithFriendbot(address);
    setNotice({
      title: ok ? 'Funded' : 'Funding failed',
      tone: ok ? 'success' : 'error',
      message: ok
        ? `Test XLM is on its way to ${address.slice(0, 4)}…${address.slice(-4)}.`
        : 'Friendbot rejected the request. Try again in a moment.',
    });
  };

  // ConfirmModal, not Alert.alert — the component exists precisely to keep a
  // decision inside Veil's visual language, and it can style a destructive
  // action as destructive, which the platform dialog cannot.
  const [resetOpen, setResetOpen] = useState(false);
  const resetWallet = () => setResetOpen(true);
  const confirmReset = async () => {
    setResetOpen(false);
    await clearWalletStore();
    router.replace('/welcome');
  };

  const developer: Row[] = [
    // Endpoints, factory contract and per-network config warnings. Diagnostic
    // rather than everyday: the Mainnet switch above is how you actually change
    // network, and this is where you look when it does not behave.
    { key: 'network-details', title: 'Network details', subtitle: 'Endpoints and contract configuration', onPress: () => router.push('/settings/network') },
    {
      key: 'fund',
      title: 'Fund test XLM',
      subtitle: onTestnet
        ? 'Top up this wallet from Friendbot'
        : 'Unavailable on mainnet — Friendbot is testnet only',
      value: 'Testnet',
      onPress: fundTestXlm,
    },
    {
      key: 'reset',
      title: 'Reset wallet',
      subtitle: onTestnet
        ? 'Clear the testnet wallet and start fresh'
        : 'Clear the MAINNET wallet — real funds',
      onPress: resetWallet,
    },
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
        {group('Notifications', notifications)}
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

      <Modal
        visible={themePickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setThemePickerOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setThemePickerOpen(false)}>
          <Pressable
            style={[styles.sheet, { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF' }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.sheetTitle}>Appearance</Text>
            {THEME_OPTIONS.map((option) => {
              const selected = option.value === preference;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => {
                    selectTheme(option.value);
                    setThemePickerOpen(false);
                  }}
                  style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
                >
                  <Text style={[styles.sheetSymbol, selected && styles.sheetSelected]}>
                    {option.glyph}
                  </Text>
                  <Text style={[styles.sheetName, selected && styles.sheetSelected]}>
                    {option.label}
                  </Text>
                  <Text style={styles.sheetCode}>{selected ? '✓' : ''}</Text>
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Network switch confirmation. Mainnet is styled destructive because it
          moves the wallet onto real funds — the one setting here that can cost
          the user money if tapped by accident. */}
      <ConfirmModal
        isOpen={pendingNetwork !== null}
        title={pendingNetwork === 'mainnet' ? 'Switch to Mainnet?' : 'Switch to Testnet?'}
        message={
          pendingNetwork === 'mainnet'
            ? 'Mainnet uses REAL funds. Your wallet, balances and history are separate per network, so this is a different wallet — not the same one on another chain.'
            : 'Back to test funds. Your mainnet wallet and its balances are kept, and switching back restores them.'
        }
        confirmLabel="Switch"
        destructive={pendingNetwork === 'mainnet'}
        onConfirm={confirmNetworkSwitch}
        onCancel={() => setPendingNetwork(null)}
      />

      {/*
        The launch-time gate in app/index.tsx sends a wallet-less device to
        /welcome, but it only runs at launch — switching network in-app left the
        user on a dashboard for a wallet that does not exist, and the first sign
        of it was a failed spend ("No passkey found on this device").

        So the switch itself offers the way out: when the new network has no
        wallet, confirming goes to wallet creation instead of dismissing.
      */}
      <NoticeModal
        isOpen={notice !== null}
        title={notice?.title ?? ''}
        message={notice?.message ?? ''}
        tone={notice?.tone ?? 'neutral'}
        onClose={() => setNotice(null)}
      />

      {/*
        Names the network it is about to wipe. The copy used to say "testnet"
        unconditionally, so on mainnet it reassured the user while clearing a
        real-funds key — the worst direction for a destructive prompt to be
        wrong in.
      */}
      <ConfirmModal
        isOpen={resetOpen}
        destructive
        title={onTestnet ? 'Reset testnet wallet?' : 'Reset your MAINNET wallet?'}
        message={
          onTestnet
            ? "Removes this device's testnet wallet key so you can create a fresh one. Your mainnet wallet is not affected."
            : 'Removes this device’s MAINNET wallet key. This wallet holds REAL funds, and without a backup they become unreachable. Back up your secret first.'
        }
        confirmLabel={onTestnet ? 'Reset' : 'Reset mainnet wallet'}
        cancelLabel="Cancel"
        onConfirm={confirmReset}
        onCancel={() => setResetOpen(false)}
      />

      <ConfirmModal
        isOpen={switchedTo !== null}
        title={switchedHasWallet ? 'Network switched' : `No wallet on ${switchedTo}`}
        message={
          switchedHasWallet
            ? `You are now on ${switchedTo}. Fully close and reopen the app so every connection picks up the new network.`
            : `You are now on ${switchedTo}, and this device has no ${switchedTo} wallet yet — each network keeps its own, so a reset on one can never touch the other. Create one to send, swap or earn here. Your other wallets are unaffected.`
        }
        confirmLabel={switchedHasWallet ? 'Got it' : 'Create wallet'}
        cancelLabel={switchedHasWallet ? 'Close' : 'Not now'}
        onConfirm={() => {
          const needsWallet = !switchedHasWallet;
          setSwitchedTo(null);
          if (needsWallet) router.push('/create-wallet');
        }}
        onCancel={() => setSwitchedTo(null)}
      />
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
