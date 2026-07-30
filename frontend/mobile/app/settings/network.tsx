import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useNetwork } from '../../hooks/useNetwork';
import {
  NETWORKS,
  NETWORK_NAMES,
  describeMissingConfig,
  getBuildTimeNetworkName,
  isNetworkConfigured,
  type VeilNetworkName,
} from '../../lib/network';

export default function NetworkScreen() {
  const { network, networkName, switchNetwork, isSwitching, error } = useNetwork();
  const buildDefault = getBuildTimeNetworkName();
  const missing = describeMissingConfig(network);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Network</Text>
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
          <ActivityIndicator color="#6366f1" />
          <Text style={styles.hint}>Switching network and reloading wallet state.</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Active endpoints</Text>
        <Detail label="Soroban RPC" value={network.rpcUrl} />
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
          {configured ? network.rpcUrl : 'Not configured in this build'}
          {isDefault ? ' · build default' : ''}
        </Text>
      </View>
      <View style={[styles.radio, selected && styles.radioSelected]} />
    </Pressable>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={2}>
        {value || 'not set'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: '#0B0B0F',
    padding: 24,
    gap: 16,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#9BA1A6',
    fontSize: 15,
  },
  options: {
    gap: 10,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#11131a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 16,
  },
  optionSelected: {
    borderColor: '#6366f1',
    backgroundColor: '#171a2b',
  },
  optionText: {
    flex: 1,
    gap: 4,
  },
  optionTitle: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
  },
  optionSubtitle: {
    color: '#94a3b8',
    fontSize: 12,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#475569',
  },
  radioSelected: {
    borderColor: '#6366f1',
    backgroundColor: '#6366f1',
  },
  switchingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  card: {
    backgroundColor: '#11131a',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    padding: 16,
    gap: 10,
  },
  cardTitle: {
    color: '#f1f5f9',
    fontSize: 15,
    fontWeight: '600',
  },
  cardBody: {
    color: '#9BA1A6',
    fontSize: 13,
    lineHeight: 19,
  },
  detailRow: {
    gap: 2,
  },
  detailLabel: {
    color: '#64748b',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  detailValue: {
    color: '#cbd5e1',
    fontSize: 13,
  },
  warningCard: {
    backgroundColor: '#1f1a11',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#78350f',
    padding: 16,
    gap: 8,
  },
  warningTitle: {
    color: '#fbbf24',
    fontSize: 15,
    fontWeight: '600',
  },
  hint: {
    color: '#94a3b8',
    fontSize: 13,
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    lineHeight: 19,
  },
});
