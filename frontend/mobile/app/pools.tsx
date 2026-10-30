import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FlowHeader } from '../components/FlowHeader';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';

type Pool = {
  id: string;
  assetA: string;
  assetB: string;
  reserveA: number;
  reserveB: number;
  totalShares: number;
  feeBp: number;
  apr: number;
  /** The user's LP token balance in this pool (0 when they hold no position). */
  yourShares: number;
};

// Representative pools; the real list comes from the AMM once wallet/pool data
// is wired (a later issue). Shapes mirror the web pools page's PoolView.
const POOLS: Pool[] = [
  {
    id: 'usdc-xlm',
    assetA: 'USDC',
    assetB: 'XLM',
    reserveA: 125000,
    reserveB: 980000,
    totalShares: 34000,
    feeBp: 30,
    apr: 12.4,
    yourShares: 340,
  },
  {
    id: 'usdc-xlm-2',
    assetA: 'USDC',
    assetB: 'XLM',
    reserveA: 88000,
    reserveB: 81000,
    totalShares: 84000,
    feeBp: 30,
    apr: 6.1,
    yourShares: 0,
  },
  {
    id: 'xlm-aqua',
    assetA: 'XLM',
    assetB: 'AQUA',
    reserveA: 500000,
    reserveB: 42000000,
    totalShares: 120000,
    feeBp: 30,
    apr: 21.7,
    yourShares: 0,
  },
];

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function PoolsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [activePool, setActivePool] = useState<Pool | null>(null);

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="pools-screen">
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <FlowHeader title="Pools" />
        <Text style={styles.subtitle}>Provide liquidity and earn a share of swap fees.</Text>

        {POOLS.map((pool) => (
          <Pressable
            key={pool.id}
            accessibilityRole="button"
            onPress={() => setActivePool(pool)}
            style={({ pressed }) => [styles.poolCard, pressed && styles.pressed]}
          >
            <View style={styles.poolHeader}>
              <Text style={styles.pair}>
                {pool.assetA} / {pool.assetB}
              </Text>
              {pool.yourShares > 0 ? (
                <View style={styles.positionBadge}>
                  <Text style={styles.positionBadgeText}>In position</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.poolStats}>
              <Stat label="APR" value={`${pool.apr.toFixed(1)}%`} accent />
              <Stat label="TVL" value={`${compact(pool.reserveA)} ${pool.assetA}`} />
              <Stat label="Fee" value={`${pool.feeBp / 100}%`} />
            </View>
          </Pressable>
        ))}
      </ScrollView>

      <LiquidityModal
        key={activePool?.id ?? 'none'}
        pool={activePool}
        onClose={() => setActivePool(null)}
      />
    </SafeAreaView>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, accent && styles.statAccent]}>{value}</Text>
    </View>
  );
}

function LiquidityModal({ pool, onClose }: { pool: Pool | null; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // A changing `key` in the parent remounts this per pool, so inputs reset.
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amountA, setAmountA] = useState('');
  const [percent, setPercent] = useState('');

  if (!pool) return null;

  // Deposit: the second asset is added in proportion to the pool's reserves.
  const inA = Number(amountA);
  const depositB = inA > 0 ? inA * (pool.reserveB / pool.reserveA) : 0;
  const canDeposit = inA > 0;

  // Withdraw: a percentage of the user's pooled amounts.
  const ownership = pool.totalShares > 0 ? pool.yourShares / pool.totalShares : 0;
  const pooledA = ownership * pool.reserveA;
  const pooledB = ownership * pool.reserveB;
  const pct = Math.min(100, Math.max(0, Number(percent)));
  const outA = (pct / 100) * pooledA;
  const outB = (pct / 100) * pooledB;
  const canWithdraw = pool.yourShares > 0 && pct > 0;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <Text style={styles.sheetPair}>
            {pool.assetA} / {pool.assetB}
          </Text>

          <View style={styles.tabs}>
            {(['deposit', 'withdraw'] as const).map((m) => (
              <Pressable
                key={m}
                accessibilityRole="button"
                onPress={() => setMode(m)}
                style={[styles.tab, mode === m && styles.tabActive]}
              >
                <Text style={[styles.tabText, mode === m && styles.tabTextActive]}>
                  {m === 'deposit' ? 'Add' : 'Remove'}
                </Text>
              </Pressable>
            ))}
          </View>

          {mode === 'deposit' ? (
            <View style={styles.form}>
              <Text style={styles.fieldLabel}>{pool.assetA} amount</Text>
              <TextInput
                style={styles.input}
                value={amountA}
                onChangeText={setAmountA}
                placeholder="0.00"
                placeholderTextColor={colors.textFaint}
                keyboardType="decimal-pad"
              />
              <Text style={styles.derived}>
                + {depositB.toLocaleString(undefined, { maximumFractionDigits: 4 })} {pool.assetB}{' '}
                (proportional)
              </Text>
              <SubmitButton label="Add liquidity" disabled={!canDeposit} />
            </View>
          ) : pool.yourShares > 0 ? (
            <View style={styles.form}>
              <Text style={styles.fieldLabel}>Withdraw %</Text>
              <TextInput
                style={styles.input}
                value={percent}
                onChangeText={setPercent}
                placeholder="0"
                placeholderTextColor={colors.textFaint}
                keyboardType="number-pad"
              />
              <Text style={styles.derived}>
                You receive ~{outA.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
                {pool.assetA} + {outB.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
                {pool.assetB}
              </Text>
              <SubmitButton label="Remove liquidity" disabled={!canWithdraw} />
            </View>
          ) : (
            <Text style={styles.empty}>You have no position in this pool yet.</Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

function SubmitButton({ label, disabled }: { label: string; disabled: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      style={[styles.submit, disabled && styles.submitDisabled]}
    >
      <Text style={styles.submitText}>{label}</Text>
    </Pressable>
  );
}

/**
 * Pools held the right brand colours as the wrong kind of value: `#0F0F0F`,
 * `#F6F7F8` and `#FDDA24` written out literally, which is exactly the dark
 * palette — so the screen looked correct until the phone was in light mode,
 * where it stayed black. The gold was the dark-mode gold too, which light mode
 * darkens to keep contrast on white.
 *
 * The sheet uses `surfaceRaised`, not `surface`: `surface` is translucent and
 * only reads as a surface over the page background, and this one floats over a
 * scrim.
 */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40, gap: 14 },
    subtitle: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 14.5,
      lineHeight: 21,
    },

    poolCard: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      padding: 16,
      gap: 14,
    },
    pressed: { opacity: 0.6 },
    poolHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    pair: { color: colors.textStrong, fontFamily: fontFamily.bodySemiBold, fontSize: 17 },
    positionBadge: {
      backgroundColor: colors.surfaceMd,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 100,
      borderWidth: 1,
      borderColor: colors.borderStrong,
    },
    positionBadgeText: {
      color: colors.accentText,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
    },
    poolStats: { flexDirection: 'row', justifyContent: 'space-between' },
    stat: { gap: 2 },
    statLabel: { color: colors.textFaint, fontFamily: fontFamily.body, fontSize: 12 },
    statValue: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 15 },
    statAccent: { color: colors.accentText },

    modalRoot: { flex: 1, justifyContent: 'flex-end' },
    // Written out rather than spread from `StyleSheet.absoluteFillObject`: that
    // helper vanished under us once already on a react-native bump, and when it
    // does the spread silently contributes nothing instead of failing.
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.6)',
    },
    sheet: {
      backgroundColor: colors.surfaceRaised,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 20,
      paddingBottom: 36,
      gap: 14,
    },
    sheetPair: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },

    tabs: {
      flexDirection: 'row',
      backgroundColor: colors.surfaceMd,
      borderRadius: 100,
      padding: 4,
      gap: 4,
    },
    tab: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 100 },
    tabActive: { backgroundColor: colors.accent },
    tabText: { color: colors.textSecondary, fontFamily: fontFamily.bodyMedium, fontSize: 14 },
    // On the accent fill, so it takes the on-accent colour rather than the gold
    // it used before — gold on gold was unreadable in both modes.
    tabTextActive: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold },

    form: { gap: 10 },
    fieldLabel: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.4,
      textTransform: 'uppercase',
    },
    input: {
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 13,
      color: colors.textPrimary,
      fontFamily: fontFamily.body,
      fontSize: 16,
      backgroundColor: colors.surface,
    },
    derived: {
      color: colors.textSecondary,
      fontFamily: fontFamily.body,
      fontSize: 13,
      lineHeight: 19,
    },
    empty: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 14, paddingVertical: 8 },

    submit: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 16,
      borderRadius: 100,
      backgroundColor: colors.accent,
      marginTop: 4,
    },
    submitDisabled: { opacity: 0.4 },
    submitText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
  });
