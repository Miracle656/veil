/**
 * Veil Invisible Wallet — minimal Expo demo
 *
 * Demonstrates register(), login(), and sign (signAuthEntry()) using
 * invisible-wallet-sdk with the React Native passkey provider.
 *
 * Before running:
 *   1. Copy .env.example → .env.local and fill in your values
 *   2. npx expo run:ios   (physical device required for passkeys)
 *   3. npx expo run:android
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useInvisibleWallet } from 'invisible-wallet-sdk';
import { Networks } from '@stellar/stellar-sdk';

// ── Config ────────────────────────────────────────────────────────────────────

const FACTORY_ADDRESS    = process.env['EXPO_PUBLIC_FACTORY_ADDRESS']    ?? '';
const RPC_URL            = process.env['EXPO_PUBLIC_RPC_URL']            ?? 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env['EXPO_PUBLIC_NETWORK_PASSPHRASE'] ?? Networks.TESTNET;
const RP_ID              = process.env['EXPO_PUBLIC_RP_ID']              ?? 'veil.app';
const ORIGIN             = process.env['EXPO_PUBLIC_ORIGIN']             ?? 'https://veil.app';

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [username, setUsername] = useState('');
  const [log, setLog] = useState<string[]>([]);

  const addLog = (msg: string) =>
    setLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

  const wallet = useInvisibleWallet({
    factoryAddress:    FACTORY_ADDRESS,
    rpcUrl:            RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpId:              RP_ID,
    origin:            ORIGIN,
    // Pass AsyncStorage so the SDK persists credentials on-device
    storage:           AsyncStorage,
  });

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleRegister = async () => {
    try {
      addLog('Starting passkey registration…');
      const result = await wallet.register(username || undefined);
      addLog(`Registered!  Address: ${result.walletAddress}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(`Register failed: ${msg}`);
      Alert.alert('Registration failed', msg);
    }
  };

  const handleLogin = async () => {
    try {
      addLog('Restoring session…');
      const result = await wallet.login();
      if (result) {
        addLog(`Logged in!  Address: ${result.walletAddress}`);
      } else {
        addLog('No wallet found — register first.');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(`Login failed: ${msg}`);
    }
  };

  const handleSignTest = async () => {
    try {
      addLog('Signing test payload (32 random bytes)…');
      const payload = new Uint8Array(32).fill(0xab);
      const sig = await wallet.signAuthEntry(payload);
      if (sig) {
        const hexSnippet = Array.from(sig.signature.slice(0, 8))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        addLog(`Signed!  sig[0..8]: ${hexSnippet}…`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog(`Sign failed: ${msg}`);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Veil Invisible Wallet</Text>
        <Text style={styles.subtitle}>React Native / Expo demo</Text>

        {wallet.address ? (
          <View style={styles.pill}>
            <Text style={styles.pillText} numberOfLines={1}>
              {wallet.address}
            </Text>
            <Text style={styles.pillLabel}>
              {wallet.isDeployed ? 'Deployed on-chain' : 'Not yet deployed'}
            </Text>
          </View>
        ) : null}

        <TextInput
          style={styles.input}
          placeholder="Username (optional)"
          placeholderTextColor="#64748b"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Pressable
          style={[styles.btn, styles.btnPrimary]}
          onPress={handleRegister}
          disabled={wallet.isPending}
        >
          <Text style={styles.btnText}>Register passkey</Text>
        </Pressable>

        <Pressable
          style={[styles.btn, styles.btnSecondary]}
          onPress={handleLogin}
          disabled={wallet.isPending}
        >
          <Text style={styles.btnText}>Login / restore session</Text>
        </Pressable>

        <Pressable
          style={[styles.btn, styles.btnAccent, !wallet.address && styles.btnDisabled]}
          onPress={handleSignTest}
          disabled={wallet.isPending || !wallet.address}
        >
          <Text style={styles.btnText}>Sign test payload</Text>
        </Pressable>

        {wallet.isPending && (
          <ActivityIndicator style={styles.spinner} color="#6366f1" />
        )}

        {wallet.error ? (
          <Text style={styles.error}>{wallet.error}</Text>
        ) : null}

        <View style={styles.logBox}>
          <Text style={styles.logTitle}>Event log</Text>
          {log.length === 0 ? (
            <Text style={styles.logEmpty}>No events yet</Text>
          ) : (
            log.map((entry, i) => (
              <Text key={i} style={styles.logEntry}>{entry}</Text>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  container: {
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: '#f1f5f9',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 14,
    color: '#94a3b8',
    marginBottom: 16,
  },
  pill: {
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  pillText: {
    color: '#a5b4fc',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  pillLabel: {
    color: '#64748b',
    fontSize: 11,
    marginTop: 4,
  },
  input: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 14,
    color: '#f1f5f9',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  btn: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#6366f1',
  },
  btnSecondary: {
    backgroundColor: '#334155',
  },
  btnAccent: {
    backgroundColor: '#0ea5e9',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  spinner: {
    marginVertical: 8,
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    backgroundColor: '#450a0a',
    borderRadius: 8,
    padding: 10,
  },
  logBox: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
    minHeight: 120,
  },
  logTitle: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  logEmpty: {
    color: '#475569',
    fontSize: 13,
    fontStyle: 'italic',
  },
  logEntry: {
    color: '#94a3b8',
    fontSize: 12,
    fontFamily: 'monospace',
    marginBottom: 4,
  },
});