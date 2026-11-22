import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../../components/FlowHeader';
import { useTheme } from '../../hooks/useTheme';
import { isWalletDeployed } from '../../lib/contractSpend';
import { getNetwork } from '../../lib/network';
import {
  readSessionAllowance,
  registerSessionAllowance,
  requestSessionPublicKey,
  revokeSessionAllowance,
  type SessionAllowance,
} from '../../lib/sessionAllowance';
import { getWalletAddress } from '../../lib/walletStore';
import type { ThemeColors } from '../../lib/theme';
import { fontFamily } from '../../theme/typography';
import { Asset, nativeToScVal } from '@stellar/stellar-sdk';
import { simulateRead } from '../../lib/contractInvoke';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC_TESTNET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function usdcContract(): string {
  const network = getNetwork();
  return new Asset('USDC', network.name === 'mainnet' ? USDC_ISSUER : USDC_TESTNET_ISSUER).contractId(network.networkPassphrase);
}

function units(value: string): bigint | null {
  if (!/^\d+(\.\d{1,7})?$/.test(value.trim()) || Number(value) <= 0) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'));
}

function displayUnits(value: bigint): string {
  const whole = value / 10_000_000n;
  const fraction = (value % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function unixDate(value: string): bigint | null {
  const date = new Date(`${value}T23:59:59Z`);
  return Number.isNaN(date.valueOf()) ? null : BigInt(Math.floor(date.valueOf() / 1000));
}

export default function AssistantAllowanceScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [wallet, setWallet] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<Uint8Array | null>(null);
  const [allowance, setAllowance] = useState<SessionAllowance | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [amount, setAmount] = useState('');
  const [endDate, setEndDate] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'undeployed' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    setMessage(null);
    try {
      const address = await getWalletAddress();
      if (!address) throw new Error('No wallet on this device yet.');
      setWallet(address);
      if (address.startsWith('C') && !(await isWalletDeployed(address))) {
        setState('undeployed');
        return;
      }
      const key = publicKey ?? (await requestSessionPublicKey(address));
      if (!publicKey) setPublicKey(key);
      const [current, rawBalance] = await Promise.all([
        readSessionAllowance(address, key),
        simulateRead(usdcContract(), 'balance', [nativeToScVal(address, { type: 'address' })]),
      ]);
      if (rawBalance === null || (typeof rawBalance !== 'bigint' && typeof rawBalance !== 'number')) {
        throw new Error('Could not read the smart wallet USDC balance.');
      }
      setAllowance(current);
      setBalance(BigInt(rawBalance));
      setState('ready');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Could not read the allowance.');
    }
  }, [publicKey]);

  useEffect(() => { void load(); }, [load]);

  const transact = useCallback(async (action: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      await load();
      setMessage('Confirmed on chain.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The transaction failed.');
    } finally {
      setBusy(false);
    }
  }, [load]);

  const give = useCallback(() => {
    const cap = units(amount);
    const expiry = unixDate(endDate);
    if (!wallet || !publicKey || !cap || !expiry) return setMessage('Enter a positive USDC amount and a valid end date.');
    return void transact(() => registerSessionAllowance(wallet, publicKey, cap, expiry));
  }, [amount, endDate, publicKey, transact, wallet]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}><FlowHeader title="Assistant allowance" /></View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.hint}>Give the assistant a total USDC cap until an end date. The wallet contract enforces the asset, amount, and expiry; it does not choose who gets paid.</Text>
        {state === 'loading' ? <View style={styles.card}><ActivityIndicator color={colors.accent} /><Text style={styles.hint}>Reading the wallet and allowance…</Text></View> : null}
        {state === 'undeployed' ? <View style={styles.card}><Text style={styles.title}>Wallet not deployed</Text><Text style={styles.hint}>Make a payment first to deploy this smart wallet, then come back to give the assistant an allowance.</Text></View> : null}
        {state === 'error' ? <View style={styles.card}><Text style={styles.title}>Couldn’t read the allowance</Text><Text style={styles.hint}>{message}</Text><Button label="Try again" onPress={() => void load()} styles={styles} /></View> : null}
        {state === 'ready' && allowance ? <View style={styles.card} testID="allowance-card">
          <Text style={styles.title}>Current allowance</Text>
          <Row label="Given" value={`${displayUnits(allowance.cap)} USDC`} styles={styles} />
          <Row label="Used" value={`${displayUnits(allowance.spent)} USDC`} styles={styles} />
          <Row label="Left" value={`${displayUnits(allowance.cap - allowance.spent)} USDC`} styles={styles} />
          <Row label="Ends" value={new Date(Number(allowance.expiry) * 1000).toLocaleDateString()} styles={styles} />
          <Row label="Smart wallet USDC" value={balance === null ? '—' : `${displayUnits(balance)} USDC`} styles={styles} />
          <Text style={styles.hint}>The allowance can only spend what the smart wallet holds.</Text>
          <Button label="Take it back" destructive onPress={() => publicKey && wallet && void transact(() => revokeSessionAllowance(wallet, publicKey))} disabled={busy} styles={styles} />
        </View> : null}
        {state === 'ready' && !allowance ? <View style={styles.card}>
          <Text style={styles.title}>Give an allowance</Text>
          <TextInput value={amount} onChangeText={setAmount} placeholder="Amount in USDC" placeholderTextColor={colors.textFaint} keyboardType="decimal-pad" style={styles.input} />
          <TextInput value={endDate} onChangeText={setEndDate} placeholder="End date (YYYY-MM-DD)" placeholderTextColor={colors.textFaint} style={styles.input} />
          <Button label="Give allowance" onPress={give} disabled={busy} styles={styles} />
          {balance !== null ? <Text style={styles.hint}>Smart wallet balance: {displayUnits(balance)} USDC</Text> : null}
        </View> : null}
        {message && state === 'ready' ? <Text style={styles.notice}>{message}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, styles }: { label: string; value: string; styles: ReturnType<typeof createStyles> }) {
  return <View style={styles.row}><Text style={styles.hint}>{label}</Text><Text style={styles.value}>{value}</Text></View>;
}

function Button({ label, onPress, disabled, destructive, styles }: { label: string; onPress: () => void; disabled?: boolean; destructive?: boolean; styles: ReturnType<typeof createStyles> }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={[styles.button, destructive && styles.dangerButton, disabled && styles.disabled]}><Text style={[styles.buttonText, destructive && styles.dangerText]}>{label}</Text></Pressable>;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background }, header: { paddingHorizontal: 20 }, content: { padding: 20, gap: 16 },
    card: { padding: 18, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, gap: 12 }, title: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 18 }, hint: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 14, lineHeight: 21 }, value: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 15 }, row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 }, input: { color: colors.textPrimary, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 10, padding: 12, fontFamily: fontFamily.body }, button: { backgroundColor: colors.accent, borderRadius: 10, padding: 13, alignItems: 'center' }, buttonText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold }, dangerButton: { backgroundColor: colors.dangerSurface, borderColor: colors.danger, borderWidth: 1 }, dangerText: { color: colors.danger }, disabled: { opacity: 0.5 }, notice: { color: colors.textSecondary, textAlign: 'center' },
  });
}
