import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';

import { Button, Card, Screen } from '../../components/ui';
import { useTheme } from '../../hooks/useTheme';
import { fontFamily } from '../../theme/typography';
import {
  buildBenchmarkRequest,
  describeBenchmark,
  timeNativeRun,
  timeWasmRun,
  type SppBenchmarkResult,
} from '../../lib/sppBenchmark';
import { isSppNativeAvailable, proveTransaction } from '../../lib/sppProver';

/**
 * The V141 benchmark screen.
 *
 * Proves the benchmark transaction on this device — natively when the
 * binary carries the module — and shows the timing, so the native-vs-WASM
 * decision record is backed by an on-device measurement anyone can repeat
 * by opening this screen. Nothing is submitted to the chain: the fixture
 * transaction is never signed into a real payment.
 *
 * Reached from Settings → Privacy; hidden entirely when the native module
 * is absent, since a screen that can only ever say "unavailable" is noise
 * for every other user.
 */
export default function SppBenchmarkScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const available = useMemo(() => isSppNativeAvailable(), []);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SppBenchmarkResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const runBenchmarkNow = useCallback(async () => {
    setRunning(true);
    setFailure(null);
    try {
      const request = buildBenchmarkRequest();
      // The native path: wall-clock around the prove call. The internal
      // Rust timing is kept alongside so bridge overhead is visible.
      const native = await timeNativeRun(async () => {
        const prove = await proveTransaction(request);
        return { nativeMs: prove.nativeMs };
      });
      // The WASM path is the web wallet's proving worker; without its bundle
      // in this build the benchmark reports native-only numbers rather than
      // inventing a comparison.
      const wasm = null;
      setResult({ native, wasm, comparison: null });
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, []);

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Prover benchmark</Text>
        <Text style={styles.body}>
          Runs the V141 benchmark transaction through the native prover and
          times it. Nothing is sent to the network.
        </Text>

        {!available && (
          <Card style={styles.noticeCard}>
            <Text style={styles.noticeText}>
              This build does not include the native prover. Rebuild with the
              spp-native module to measure it.
            </Text>
          </Card>
        )}

        <Card>
          <Text style={styles.sectionLabel}>Status</Text>
          <View style={styles.row}>
            <Text style={styles.body}>Native prover</Text>
            <Text style={available ? styles.valueGood : styles.valueMuted}>
              {available ? 'Available' : 'Not in this build'}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.body}>Last run</Text>
            <Text style={styles.valueMuted}>
              {result ? `${result.native.durationMs} ms` : '—'}
            </Text>
          </View>
        </Card>

        {result && (
          <Card variant="md">
            <Text style={styles.sectionLabel}>Result</Text>
            <Text style={styles.body}>{describeBenchmark(result)}</Text>
            {result.native.internalMs !== null && (
              <Text style={styles.detail}>
                In-prover time {result.native.internalMs} ms · wall clock{' '}
                {result.native.durationMs} ms
              </Text>
            )}
          </Card>
        )}

        {failure && (
          <Card style={styles.errorCard}>
            <Text style={styles.errorText}>{failure}</Text>
          </Card>
        )}

        <Button
          label={running ? 'Proving…' : 'Run benchmark'}
          onPress={runBenchmarkNow}
          disabled={running || !available}
        />
      </ScrollView>
    </Screen>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>['colors']) =>
  StyleSheet.create({
    content: {
      gap: 16,
      paddingBottom: 32,
    },
    title: {
      fontFamily: fontFamily.heading,
      fontSize: 28,
      lineHeight: 34,
      color: colors.textStrong,
    },
    sectionLabel: {
      fontFamily: fontFamily.accent,
      fontSize: 13,
      letterSpacing: 1,
      textTransform: 'uppercase',
      color: colors.label,
      marginBottom: 12,
    },
    body: {
      fontFamily: fontFamily.body,
      fontSize: 16,
      lineHeight: 24,
      color: colors.textPrimary,
    },
    detail: {
      fontFamily: fontFamily.address,
      fontSize: 14,
      color: colors.textMuted,
      marginTop: 8,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 6,
    },
    valueGood: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 15,
      color: colors.positive,
    },
    valueMuted: {
      fontFamily: fontFamily.bodyMedium,
      fontSize: 15,
      color: colors.textMuted,
    },
    noticeCard: {
      borderColor: colors.border,
    },
    noticeText: {
      fontFamily: fontFamily.body,
      fontSize: 15,
      lineHeight: 22,
      color: colors.textSecondary,
    },
    errorCard: {
      borderColor: colors.danger,
      backgroundColor: colors.dangerSurface,
    },
    errorText: {
      fontFamily: fontFamily.body,
      fontSize: 15,
      lineHeight: 22,
      color: colors.danger,
    },
  });
