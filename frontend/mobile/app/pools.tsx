import { useState } from 'react';
import {
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

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
    id: 'usdc-eurc',
    assetA: 'USDC',
    assetB: 'EURC',
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
  const [activePool, setActivePool] = useState<Pool | null>(null);

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Pools</Text>
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
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, accent && styles.statAccent]}>{value}</Text>
    </View>
  );
}

function LiquidityModal({ pool, onClose }: { pool: Pool | null; onClose: () => void }) {
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
                placeholderTextColor="rgba(246,247,248,0.3)"
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
                placeholderTextColor="rgba(246,247,248,0.3)"
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0F0F0F' },
  content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40, gap: 12 },
  title: { color: '#F6F7F8', fontSize: 28, fontWeight: '700' },
  subtitle: { color: 'rgba(246,247,248,0.55)', fontSize: 15, marginTop: -8, marginBottom: 4 },
  poolCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: 18,
    gap: 14,
  },
  pressed: { opacity: 0.7 },
  poolHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pair: { color: '#F6F7F8', fontSize: 17, fontWeight: '600' },
  positionBadge: {
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 100,
    backgroundColor: 'rgba(253,218,36,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(253,218,36,0.25)',
  },
  positionBadgeText: { color: '#FDDA24', fontSize: 11, fontWeight: '600' },
  poolStats: { flexDirection: 'row', gap: 24 },
  stat: { gap: 2 },
  statLabel: { color: 'rgba(246,247,248,0.4)', fontSize: 12 },
  statValue: { color: '#F6F7F8', fontSize: 15, fontWeight: '500' },
  statAccent: { color: '#FDDA24' },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: '#141418',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 32,
    gap: 16,
  },
  sheetPair: { color: '#F6F7F8', fontSize: 18, fontWeight: '700' },
  tabs: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 100,
    padding: 4,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 100 },
  tabActive: { backgroundColor: 'rgba(253,218,36,0.15)' },
  tabText: { color: 'rgba(246,247,248,0.55)', fontSize: 14, fontWeight: '500' },
  tabTextActive: { color: '#FDDA24' },
  form: { gap: 10 },
  fieldLabel: { color: 'rgba(246,247,248,0.4)', fontSize: 12, letterSpacing: 1 },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#F6F7F8',
    fontSize: 18,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  derived: { color: 'rgba(246,247,248,0.55)', fontSize: 13, lineHeight: 18 },
  empty: { color: 'rgba(246,247,248,0.55)', fontSize: 14, paddingVertical: 8 },
  submit: {
    marginTop: 6,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 100,
    backgroundColor: '#FDDA24',
  },
  submitDisabled: { opacity: 0.4 },
  submitText: { color: '#0F0F0F', fontSize: 15, fontWeight: '600' },
});
