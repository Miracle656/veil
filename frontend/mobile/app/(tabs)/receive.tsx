import { useState } from 'react';
import { Pressable, SafeAreaView, Share, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';

import { buildSep7PayUri } from '../../lib/sep7';

// Placeholder address — the mobile shell has no wallet integration yet (that
// lands with a later issue), so the screen renders a representative address.
const ADDRESS = 'GA3DHM4WL2VXPHR7NQKPZ7XK9FQJ2ULTQ6ZT4W2M5N6Q7RSTUVWXK9FQ';

export default function ReceiveScreen() {
  const [copied, setCopied] = useState(false);
  // Destination only for now; the amount/asset/memo fields the builder accepts
  // become useful once this screen can request a specific amount.
  const payUri = buildSep7PayUri({ destination: ADDRESS });

  async function handleCopy() {
    await Clipboard.setStringAsync(ADDRESS);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  async function handleShare() {
    await Share.share({ message: ADDRESS, title: 'My Veil wallet address' });
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.body}>
        <Text style={styles.title}>Receive</Text>
        <Text style={styles.subtitle}>Show this to get paid on Stellar.</Text>

        <View style={styles.qrCard}>
          <View style={styles.qrFrame}>
            <QRCode value={payUri} size={196} backgroundColor="#FFFFFF" color="#0F0F0F" />
          </View>
        </View>

        <View style={styles.addressCard}>
          <Text style={styles.addressLabel}>YOUR ADDRESS</Text>
          <Text style={styles.address} selectable>
            {ADDRESS}
          </Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            onPress={handleCopy}
            accessibilityRole="button"
            style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && styles.pressed]}
          >
            <Text style={styles.btnGhostText}>{copied ? 'Copied' : 'Copy'}</Text>
          </Pressable>
          <Pressable
            onPress={handleShare}
            accessibilityRole="button"
            style={({ pressed }) => [styles.btn, styles.btnGold, pressed && styles.pressed]}
          >
            <Text style={styles.btnGoldText}>Share</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0F0F0F',
  },
  body: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
    gap: 20,
  },
  title: {
    color: '#F6F7F8',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: 'rgba(246,247,248,0.55)',
    fontSize: 15,
    marginTop: -12,
  },
  qrCard: {
    alignItems: 'center',
    paddingVertical: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  qrFrame: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  addressCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(253,218,36,0.18)',
    backgroundColor: 'rgba(253,218,36,0.08)',
    gap: 8,
  },
  addressLabel: {
    color: 'rgba(246,247,248,0.4)',
    fontSize: 12,
    letterSpacing: 1,
  },
  address: {
    color: '#FDDA24',
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  btn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 100,
  },
  pressed: {
    transform: [{ scale: 0.98 }],
  },
  btnGhost: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  btnGhostText: {
    color: '#F6F7F8',
    fontSize: 15,
    fontWeight: '500',
  },
  btnGold: {
    backgroundColor: '#FDDA24',
  },
  btnGoldText: {
    color: '#0F0F0F',
    fontSize: 15,
    fontWeight: '600',
  },
});
