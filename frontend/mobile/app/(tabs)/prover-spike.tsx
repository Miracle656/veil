/**
 * Prover spike benchmark screen — Issue #720.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VISIBILITY GATE
 * ─────────────────────────────────────────────────────────────────────────────
 * This screen is only accessible in development builds or when the
 * `EXPO_PUBLIC_PROVER_SPIKE` env var is set to `"1"`.  In production the
 * screen renders nothing and the route can be removed entirely once ADR 0004
 * has been accepted and the winning approach is implemented.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT MEASURES
 * ─────────────────────────────────────────────────────────────────────────────
 * • Wall-clock proof time (ms) — from `performance.now()` brackets in bench.ts
 * • Peak heap delta (bytes) — from `performance.memory.usedJSHeapSize` samples
 * • Device context — model, API level, total RAM, CPU cores (expo-device)
 *
 * Results are displayed in a side-by-side comparison table and can be exported
 * as JSON via the system share sheet so the numbers can be pasted directly into
 * `docs/adr/0004-mobile-prover-webview-vs-native.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW TO RUN ON DEVICE
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Build a dev client: `npm run build:android:dev`
 *   2. Open the app and navigate to Settings → Developer → Prover Spike.
 *      (Or navigate directly via the URL scheme: veil://prover-spike)
 *   3. Tap "Run WebView prover" and wait for the result (~3–8 s).
 *   4. Tap "Run Native (stub)" and wait for the result (~1–3 s).
 *   5. Tap "Export JSON" and copy the result into the ADR table.
 *
 * Run on at least two low-end devices.  The issue specifies a named device;
 * use a Redmi 9 (Helio G80, 3/4 GB RAM, Android 11, API 30) or similar
 * sub-$150 Android phone.
 */

import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { formatBytes, formatMs, runBench } from '../../lib/prover/bench';
import { proveNative } from '../../lib/prover/native';
import { ProverWebView, ProverWebViewHandle, proveWebView } from '../../lib/prover/webview';
import { BenchResult, MockSppTx, SpikeBenchRun } from '../../lib/prover/types';

// ---------------------------------------------------------------------------
// Visibility gate
// ---------------------------------------------------------------------------

const SPIKE_ENABLED =
  __DEV__ || process.env.EXPO_PUBLIC_PROVER_SPIKE === '1';

// ---------------------------------------------------------------------------
// Mock transaction used for benchmarking
// ---------------------------------------------------------------------------

const BENCH_TX: MockSppTx = {
  // Fake 32-byte note commitment
  commitment: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
  amountStroops: BigInt('100_000_000'), // 10 XLM
  assetCode: 'XLM',
  poolAddress: 'CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RunState = 'idle' | 'running' | 'done' | 'error';

interface ProverState {
  state: RunState;
  result: BenchResult | null;
  error: string | null;
}

const INITIAL_STATE: ProverState = { state: 'idle', result: null, error: null };

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionHeaderText}>{title}</Text>
    </View>
  );
}

function StatRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, highlight && styles.statValueHighlight]}>{value}</Text>
    </View>
  );
}

function ProverCard({
  label,
  description,
  state,
  result,
  error,
  onRun,
}: {
  label: string;
  description: string;
  state: RunState;
  result: BenchResult | null;
  error: string | null;
  onRun: () => void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{label}</Text>
      <Text style={styles.cardDesc}>{description}</Text>

      <Pressable
        style={[styles.runButton, state === 'running' && styles.runButtonDisabled]}
        onPress={onRun}
        disabled={state === 'running'}
        accessibilityRole="button"
        accessibilityLabel={`Run ${label}`}
        accessibilityState={{ disabled: state === 'running', busy: state === 'running' }}
      >
        {state === 'running' ? (
          <ActivityIndicator color="#0F0F0F" size="small" />
        ) : (
          <Text style={styles.runButtonText}>
            {state === 'done' ? '↻ Re-run' : 'Run prover'}
          </Text>
        )}
      </Pressable>

      {state === 'running' && (
        <Text style={styles.statusText}>Proving… (may take up to 30 s)</Text>
      )}

      {state === 'error' && error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {state === 'done' && result && (
        <View style={styles.results}>
          <StatRow label="Proof time" value={formatMs(result.wallClockMs)} highlight />
          <StatRow
            label="Peak heap Δ"
            value={result.peakHeapBytes > 0 ? formatBytes(result.peakHeapBytes) : 'n/a'}
          />
          <StatRow label="Device" value={result.deviceModel || 'Unknown'} />
          <StatRow label="CPU cores" value={String(result.cpuCores || 'n/a')} />
          <StatRow
            label="Total RAM"
            value={result.totalMemoryBytes > 0 ? formatBytes(result.totalMemoryBytes) : 'n/a'}
          />
          <StatRow label="Android API" value={String(result.androidApiLevel || 'n/a')} />
          <StatRow label="Verified" value={result.verified ? '✓ yes' : '✗ no'} />
        </View>
      )}
    </View>
  );
}

function ComparisonTable({ run }: { run: SpikeBenchRun }) {
  if (!run.webview && !run.native) return null;

  const wv = run.webview;
  const nat = run.native;

  const wvFaster =
    wv && nat ? wv.wallClockMs < nat.wallClockMs : false;
  const natFaster = !wvFaster && !!(wv && nat);

  return (
    <View style={styles.compareCard}>
      <Text style={styles.compareTitle}>Side-by-side comparison</Text>
      <View style={styles.compareHeader}>
        <Text style={styles.compareColHeader} />
        <Text style={[styles.compareColHeader, wvFaster && styles.winnerCol]}>WebView</Text>
        <Text style={[styles.compareColHeader, natFaster && styles.winnerCol]}>Native stub</Text>
      </View>

      <CompareRow
        label="Proof time"
        wv={wv ? formatMs(wv.wallClockMs) : '—'}
        nat={nat ? formatMs(nat.wallClockMs) : '—'}
        wvBetter={wvFaster}
        natBetter={natFaster}
      />
      <CompareRow
        label="Peak heap Δ"
        wv={wv && wv.peakHeapBytes > 0 ? formatBytes(wv.peakHeapBytes) : 'n/a'}
        nat={nat && nat.peakHeapBytes > 0 ? formatBytes(nat.peakHeapBytes) : 'n/a'}
        wvBetter={
          wv && nat && wv.peakHeapBytes > 0 && nat.peakHeapBytes > 0
            ? wv.peakHeapBytes < nat.peakHeapBytes
            : false
        }
        natBetter={
          wv && nat && wv.peakHeapBytes > 0 && nat.peakHeapBytes > 0
            ? nat.peakHeapBytes < wv.peakHeapBytes
            : false
        }
      />
      <CompareRow
        label="App size added"
        wv="~2 MB"
        nat="~4–6 MB"
        wvBetter
        natBetter={false}
      />
      <CompareRow
        label="Impl. effort"
        wv="3–4 weeks"
        nat="6–8 weeks"
        wvBetter
        natBetter={false}
      />
    </View>
  );
}

function CompareRow({
  label,
  wv,
  nat,
  wvBetter,
  natBetter,
}: {
  label: string;
  wv: string;
  nat: string;
  wvBetter: boolean;
  natBetter: boolean;
}) {
  return (
    <View style={styles.compareRow}>
      <Text style={styles.compareRowLabel}>{label}</Text>
      <Text style={[styles.compareCell, wvBetter && styles.compareCellWinner]}>{wv}</Text>
      <Text style={[styles.compareCell, natBetter && styles.compareCellWinner]}>{nat}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function ProverSpikeScreen() {
  if (!SPIKE_ENABLED) {
    return (
      <SafeAreaView style={styles.root}>
        <Text style={styles.gatedText}>
          Prover spike screen is only available in development builds.
        </Text>
      </SafeAreaView>
    );
  }

  return <ProverSpikeContent />;
}

function ProverSpikeContent() {
  const webViewRef = useRef<ProverWebViewHandle>(null);

  const [webviewState, setWebviewState] = useState<ProverState>(INITIAL_STATE);
  const [nativeState, setNativeState] = useState<ProverState>(INITIAL_STATE);

  // Build the SpikeBenchRun whenever we have at least one result
  const run: SpikeBenchRun = {
    webview: webviewState.result,
    native: nativeState.result,
    deviceModel: webviewState.result?.deviceModel ?? nativeState.result?.deviceModel ?? '',
    androidApiLevel:
      webviewState.result?.androidApiLevel ?? nativeState.result?.androidApiLevel ?? 0,
    totalMemoryBytes:
      webviewState.result?.totalMemoryBytes ?? nativeState.result?.totalMemoryBytes ?? 0,
    cpuCores: webviewState.result?.cpuCores ?? nativeState.result?.cpuCores ?? 0,
    runTimestamp: new Date().toISOString(),
  };

  // ── WebView run ────────────────────────────────────────────────────────────

  const runWebView = useCallback(async () => {
    setWebviewState({ state: 'running', result: null, error: null });
    try {
      const result = await runBench(
        (tx) => proveWebView(webViewRef, tx),
        BENCH_TX,
      );
      setWebviewState({ state: 'done', result, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setWebviewState({ state: 'error', result: null, error: message });
    }
  }, []);

  // ── Native run ─────────────────────────────────────────────────────────────

  const runNative = useCallback(async () => {
    setNativeState({ state: 'running', result: null, error: null });
    try {
      const result = await runBench(proveNative, BENCH_TX);
      setNativeState({ state: 'done', result, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setNativeState({ state: 'error', result: null, error: message });
    }
  }, []);

  // ── Export ─────────────────────────────────────────────────────────────────

  const exportResults = useCallback(async () => {
    const payload = {
      spike: '#720 mobile-prover-spike',
      run: {
        ...run,
        webview: webviewState.result
          ? { ...webviewState.result, proofBytes: `<${webviewState.result.proofBytes.byteLength} bytes>` }
          : null,
        native: nativeState.result
          ? { ...nativeState.result, proofBytes: `<${nativeState.result.proofBytes.byteLength} bytes>` }
          : null,
      },
    };
    const json = JSON.stringify(payload, null, 2);

    try {
      if (Platform.OS === 'android' || Platform.OS === 'ios') {
        const uri = FileSystem.cacheDirectory + 'prover-spike-results.json';
        await FileSystem.writeAsStringAsync(uri, json, { encoding: FileSystem.EncodingType.UTF8 });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, { mimeType: 'application/json' });
        } else {
          await Clipboard.setStringAsync(json);
          Alert.alert('Copied', 'Results copied to clipboard (sharing not available).');
        }
      } else {
        await Clipboard.setStringAsync(json);
        Alert.alert('Copied', 'Results JSON copied to clipboard.');
      }
    } catch (err) {
      Alert.alert('Export failed', String(err));
    }
  }, [run, webviewState.result, nativeState.result]);

  const hasAnyResult = !!(webviewState.result || nativeState.result);

  return (
    <SafeAreaView style={styles.root}>
      {/* Hidden WebView — must be mounted at the root, outside the ScrollView */}
      <ProverWebView ref={webViewRef} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTag}>SPIKE #720</Text>
          <Text style={styles.headerTitle}>Mobile Prover Benchmark</Text>
          <Text style={styles.headerSub}>
            Measures proof time and peak memory for WebView (WASM) and native
            (arkworks stub) approaches. Results feed into ADR 0004.
          </Text>
        </View>

        {/* WebView card */}
        <SectionHeader title="Option A — WebView (WASM)" />
        <ProverCard
          label="WebView prover"
          description="Runs the SPP browser SDK inside a hidden 0×0 WebView. Proof time expected 3–8 s on low-end Android (no SIMD/threads in WebView < Android 10). App size: +~2 MB."
          state={webviewState.state}
          result={webviewState.result}
          error={webviewState.error}
          onRun={runWebView}
        />

        {/* Native card */}
        <SectionHeader title="Option B — Native stub (arkworks)" />
        <ProverCard
          label="Native prover (stub)"
          description="Simulates a Turbo Module wrapping the Rust SPP SDK (arkworks/BN254, Rayon threads). Proof time expected 0.7–2.5 s. App size: +~4–6 MB (.so per ABI)."
          state={nativeState.state}
          result={nativeState.result}
          error={nativeState.error}
          onRun={runNative}
        />

        {/* Comparison */}
        {hasAnyResult && (
          <>
            <SectionHeader title="Comparison" />
            <ComparisonTable run={run} />
          </>
        )}

        {/* Export */}
        {hasAnyResult && (
          <Pressable
            style={styles.exportButton}
            onPress={exportResults}
            accessibilityRole="button"
            accessibilityLabel="Export benchmark results as JSON"
          >
            <Text style={styles.exportButtonText}>Export JSON → ADR 0004</Text>
          </Pressable>
        )}

        {/* Footnote */}
        <Text style={styles.footnote}>
          Peak heap Δ is sampled from `performance.memory.usedJSHeapSize`. On
          Hermes this field is absent (returns 0). App size figures are
          pre-analysis estimates; measure with `npx eas build --profile preview`
          and compare APK sizes.
        </Text>

        <View style={styles.bottomSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const YELLOW = '#FDDA24';
const BG = '#0F0F0F';
const SURFACE = '#1A1A1A';
const BORDER = '#2A2A2A';
const TEXT = '#F0F0F0';
const MUTED = '#888';
const GREEN = '#4ADE80';

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BG,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  gatedText: {
    color: MUTED,
    textAlign: 'center',
    marginTop: 64,
    fontFamily: 'monospace',
  },

  // Header
  header: {
    paddingTop: 24,
    paddingBottom: 16,
  },
  headerTag: {
    color: YELLOW,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  headerTitle: {
    color: TEXT,
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  headerSub: {
    color: MUTED,
    fontSize: 13,
    lineHeight: 19,
  },

  // Section header
  sectionHeader: {
    marginTop: 20,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
    paddingBottom: 6,
  },
  sectionHeaderText: {
    color: YELLOW,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },

  // Prover card
  card: {
    backgroundColor: SURFACE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 16,
    marginBottom: 12,
  },
  cardTitle: {
    color: TEXT,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  cardDesc: {
    color: MUTED,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 12,
  },
  runButton: {
    backgroundColor: YELLOW,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    height: 42,
  },
  runButtonDisabled: {
    opacity: 0.5,
  },
  runButtonText: {
    color: BG,
    fontSize: 14,
    fontWeight: '700',
  },
  statusText: {
    color: MUTED,
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
  },
  errorBox: {
    marginTop: 10,
    backgroundColor: '#3B1A1A',
    borderRadius: 6,
    padding: 10,
    borderWidth: 1,
    borderColor: '#7F2020',
  },
  errorText: {
    color: '#FF6B6B',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  results: {
    marginTop: 12,
    gap: 6,
  },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  statLabel: {
    color: MUTED,
    fontSize: 12,
  },
  statValue: {
    color: TEXT,
    fontSize: 13,
    fontWeight: '500',
    fontFamily: 'monospace',
  },
  statValueHighlight: {
    color: GREEN,
    fontWeight: '700',
  },

  // Comparison table
  compareCard: {
    backgroundColor: SURFACE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 16,
    marginBottom: 12,
  },
  compareTitle: {
    color: TEXT,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 10,
  },
  compareHeader: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  compareColHeader: {
    flex: 1,
    color: MUTED,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    textAlign: 'center',
  },
  winnerCol: {
    color: GREEN,
  },
  compareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  compareRowLabel: {
    flex: 1,
    color: MUTED,
    fontSize: 12,
  },
  compareCell: {
    flex: 1,
    color: TEXT,
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  compareCellWinner: {
    color: GREEN,
    fontWeight: '700',
  },

  // Export button
  exportButton: {
    borderWidth: 1,
    borderColor: YELLOW,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  exportButtonText: {
    color: YELLOW,
    fontSize: 14,
    fontWeight: '600',
  },

  // Footnote
  footnote: {
    color: MUTED,
    fontSize: 11,
    lineHeight: 16,
    fontStyle: 'italic',
    marginBottom: 8,
  },
  bottomSpacer: { height: 24 },
});
