import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { getBootnodeStatus, resolveBootnodeWithFallback, BootnodeStatus } from '../lib/privacy/bootnode';
import { getConfiguredBootnodeUrl } from '../lib/privacy/config';

export function BootnodeBanner() {
  const [status, setStatus] = useState<BootnodeStatus | null>(null);

  useEffect(() => {
    // Probe the primary bootnode URL.
    const primary = process.env.EXPO_PUBLIC_SPP_BOOTNODE_URL || null;
    
    // Fire-and-forget the probe, then update status
    resolveBootnodeWithFallback(primary).then(() => {
      setStatus(getBootnodeStatus());
    });

    const interval = setInterval(() => {
      resolveBootnodeWithFallback(primary).then(() => {
        setStatus(getBootnodeStatus());
      });
    }, 60_000);
    
    return () => clearInterval(interval);
  }, []);

  // Developer diagnostic, not a user-facing warning.
  //
  // This is mounted in the root layout, so without this gate it sits across
  // the top of EVERY screen — over the status bar — telling someone paying an
  // electricity bill which bootnode the privacy prover fell back to. The
  // community build leaves `EXPO_PUBLIC_SPP_BOOTNODE_URL` unset, so it showed
  // for every user, always.
  if (!__DEV__) {
    return null;
  }

  if (!status || !status.usingFallback || !status.reason) {
    return null;
  }

  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        <Text style={styles.bold}>Warning:</Text> {status.reason}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(234, 179, 8, 0.1)', // yellow-500/10
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(234, 179, 8, 0.2)', // yellow-500/20
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  text: {
    textAlign: 'center',
    fontSize: 14,
    color: '#ca8a04', // yellow-600
  },
  bold: {
    fontWeight: '600',
  },
});
