import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { deriveCounterfactualAddress } from 'invisible-wallet-sdk';

type CounterfactualAddressPreviewProps = {
  /** P-256 public key as an uncompressed 65-byte Uint8Array (0x04 || x || y). */
  publicKey: Uint8Array;
  /** The factory contract's Stellar strkey (e.g. "CABC..."). */
  factoryAddress: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
};

type PreviewState =
  | { status: 'deriving' }
  | { status: 'ready'; address: string; publicKeyHex: string }
  | { status: 'error'; message: string };

export function CounterfactualAddressPreview({
  publicKey,
  factoryAddress,
  networkPassphrase,
}: CounterfactualAddressPreviewProps) {
  const [state, setState] = useState<PreviewState>({ status: 'deriving' });

  useEffect(() => {
    try {
      const result = deriveCounterfactualAddress(publicKey, {
        factoryAddress,
        networkPassphrase,
      });
      setState({
        status: 'ready',
        address: result.address,
        publicKeyHex: result.publicKeyHex,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ status: 'error', message: msg });
    }
  }, [publicKey, factoryAddress, networkPassphrase]);

  if (state.status === 'deriving') {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="small" color="#F6F7F8" />
        <Text style={styles.loadingText}>Deriving address...</Text>
      </View>
    );
  }

  if (state.status === 'error') {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>Failed to derive address</Text>
        <Text style={styles.errorDetail}>{state.message}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>PREDICTED ADDRESS</Text>
      </View>

      <Text style={styles.address}>{state.address}</Text>

      <Text style={styles.hint}>
        This is your wallet's contract address before deployment.
        You can fund it immediately — once deployed, the address will match.
      </Text>

      <View style={styles.accordion}>
        <Text style={styles.accordionLabel}>Public key (hex)</Text>
        <Text style={styles.accordionValue} selectable>
          {state.publicKeyHex.slice(0, 32)}...
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#141519',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(246,247,248,0.1)',
    padding: 16,
    gap: 12,
  },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(212,175,55,0.15)',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  badgeText: {
    color: '#D4AF37',
    fontSize: 10,
    fontFamily: 'Inconsolata, monospace',
    letterSpacing: 0.5,
    fontWeight: '700',
  },
  address: {
    color: '#F6F7F8',
    fontSize: 13,
    fontFamily: 'Inconsolata, monospace',
    lineHeight: 20,
    letterSpacing: 0.3,
  },
  hint: {
    color: 'rgba(246,247,248,0.45)',
    fontSize: 12,
    lineHeight: 18,
  },
  accordion: {
    backgroundColor: 'rgba(246,247,248,0.04)',
    borderRadius: 8,
    padding: 10,
    gap: 4,
  },
  accordionLabel: {
    color: 'rgba(246,247,248,0.35)',
    fontSize: 10,
    fontFamily: 'Anton, Impact, sans-serif',
    letterSpacing: 0.5,
  },
  accordionValue: {
    color: 'rgba(246,247,248,0.5)',
    fontSize: 11,
    fontFamily: 'Inconsolata, monospace',
  },
  loadingText: {
    color: 'rgba(246,247,248,0.5)',
    fontSize: 13,
    textAlign: 'center',
  },
  errorText: {
    color: '#FF6464',
    fontSize: 13,
    fontWeight: '600',
  },
  errorDetail: {
    color: 'rgba(255,100,100,0.7)',
    fontSize: 12,
    fontFamily: 'Inconsolata, monospace',
  },
});
