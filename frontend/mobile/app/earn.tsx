import { ScreenScaffold, colors } from '@/components/ScreenScaffold';
import { Keypair } from '@stellar/stellar-sdk';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  buildBlendSupplyXdr,
  buildBlendWithdrawXdr,
  loadBlendPools,
  loadBlendPositions,
  type BlendPool,
  type BlendPosition,
} from '../lib/blend';
import { getNetwork } from '../lib/network';
import { requirePasskey } from '../lib/passkey';
import { signAndSubmitSorobanXdr } from '../lib/sorobanTx';
import { getSignerSecret, getWalletAddress } from '../lib/walletStore';

/**
 * Earn — supply idle assets to Blend lending pools and redeem them.
 *
 * Ported from `frontend/wallet/app/earn/page.tsx`. Same step machine and the
 * same Blend calls; what differs is the mobile shell (`ScreenScaffold`), the
 * keychain-backed wallet store in place of session/local storage, and the device
 * passkey standing in for `navigator.credentials`.
 */

const network = getNetwork();

const STROOPS = 1e7;

type EarnStep =
  | 'pools'
  | 'deposit-form'
  | 'depositing'
  | 'deposit-done'
  | 'withdraw-form'
  | 'withdrawing'
  | 'withdraw-done'
  | 'error';

function toUnits(stroops: string, fractionDigits: number): string {
  return (Number(stroops) / STROOPS).toFixed(fractionDigits);
}

/** Map a raw failure onto something the user can act on. */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('cancel') || lower.includes('abort')) {
    return 'Passkey cancelled. Please try again.';
  }
  if (lower.includes('utilization') || lower.includes('cap')) {
    return 'Pool is at capacity — deposits temporarily unavailable.';
  }
  return message;
}

export default function EarnRoute() {
  const router = useRouter();

  const [step, setStep] = useState<EarnStep>('pools');
  const [accountAddress, setAccountAddress] = useState<string | null>(null);

  const [pools, setPools] = useState<BlendPool[]>([]);
  const [positions, setPositions] = useState<BlendPosition[]>([]);
  const [loadingPools, setLoadingPools] = useState(true);

  const [selectedPool, setSelectedPool] = useState<BlendPool | null>(null);
  const [depositAmount, setDepositAmount] = useState('');
  const [selectedPosition, setSelectedPosition] = useState<BlendPosition | null>(null);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const loadData = useCallback(async (address: string) => {
    setLoadingPools(true);
    const [nextPools, nextPositions] = await Promise.all([
      loadBlendPools(),
      loadBlendPositions(address),
    ]);
    setPools(nextPools);
    setPositions(nextPositions);
    setLoadingPools(false);
  }, []);

  // ── Load session ──
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const walletAddress = await getWalletAddress();
      if (cancelled) return;
      if (!walletAddress) {
        router.replace('/lock');
        return;
      }

      // Blend is called by the fee-payer account, so that key is what has to be
      // present — not just the wallet contract address.
      const signerSecret = await getSignerSecret();
      if (cancelled) return;
      if (!signerSecret) {
        setErrorMsg('Signing key not found. Return to the dashboard and set up a fee-payer first.');
        setStep('error');
        setLoadingPools(false);
        return;
      }

      const resolvedAddress = Keypair.fromSecret(signerSecret).publicKey();
      setAccountAddress(resolvedAddress);
      await loadData(resolvedAddress);
    })();

    return () => {
      cancelled = true;
    };
  }, [router, loadData]);

  // ── Deposit ──
  async function handleDeposit() {
    if (!selectedPool || !accountAddress || !depositAmount) return;
    setStep('depositing');
    setErrorMsg(null);
    try {
      await requirePasskey();

      const signerSecret = await getSignerSecret();
      if (!signerSecret) throw new Error('Signing key not found. Please unlock the wallet again.');

      const amountInStroops = BigInt(Math.round(parseFloat(depositAmount) * STROOPS));
      // Pools are single-asset in this release, so the first reserve is the one
      // being supplied.
      const assetContract = selectedPool.assets[0] ?? '';

      const xdr = await buildBlendSupplyXdr({
        poolId: selectedPool.id,
        assetContract,
        amountInStroops,
        supplierAddress: accountAddress,
        sourceAddress: accountAddress,
      });
      if (!xdr) throw new Error('Failed to build the deposit transaction.');

      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
      });

      setTxHash(hash);
      setStep('deposit-done');
      setDepositAmount('');
      await loadData(accountAddress);
    } catch (error: unknown) {
      setErrorMsg(describeFailure(error));
      setStep('error');
    }
  }

  // ── Withdraw ──
  async function handleWithdraw() {
    if (!selectedPosition || !accountAddress) return;
    setStep('withdrawing');
    setErrorMsg(null);
    try {
      await requirePasskey();

      const signerSecret = await getSignerSecret();
      if (!signerSecret) throw new Error('Signing key not found. Please unlock the wallet again.');

      const xdr = await buildBlendWithdrawXdr({
        poolId: selectedPosition.poolId,
        assetContract: selectedPosition.asset,
        bTokenAmount: BigInt(selectedPosition.bTokenBalance),
        supplierAddress: accountAddress,
        sourceAddress: accountAddress,
      });
      if (!xdr) throw new Error('Failed to build the withdraw transaction.');

      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
      });

      setTxHash(hash);
      setStep('withdraw-done');
      await loadData(accountAddress);
    } catch (error: unknown) {
      setErrorMsg(describeFailure(error));
      setStep('error');
    }
  }

  const showLists = step === 'pools' || step === 'deposit-form' || step === 'withdraw-form';
  const depositIsValid = parseFloat(depositAmount) > 0;

  return (
    <ScreenScaffold
      eyebrow="Earn"
      title="Yield on-chain"
      description="Supply assets to Blend lending pools and earn yield, signed by your passkey."
      backHref="/dashboard"
      backLabel="Dashboard"
    >
      {showLists && positions.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Your positions</Text>
          {positions.map((position) => (
            <View key={`${position.poolId}-${position.asset}`} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>{position.asset.slice(0, 8)}…</Text>
                <Text style={styles.cardMeta}>Pool {position.poolId.slice(0, 6)}…</Text>
              </View>
              <Row label="Deposited" value={toUnits(position.deposited, 4)} />
              <Row
                label="Accrued interest"
                value={`+${toUnits(position.accruedInterest, 6)}`}
                accent
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setSelectedPosition(position);
                  setStep('withdraw-form');
                }}
                style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
              >
                <Text style={styles.ghostButtonText}>Withdraw</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}

      {showLists ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Available pools</Text>

          {loadingPools ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.gold} />
            </View>
          ) : pools.length === 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>No pools available</Text>
              <Text style={styles.cardMeta}>
                No Blend pools are configured for {network.displayName}. Set
                EXPO_PUBLIC_BLEND_POOL_IDS to a comma-separated list of pool contract ids.
              </Text>
            </View>
          ) : (
            pools.map((pool) => (
              <View
                key={pool.id}
                style={[styles.card, selectedPool?.id === pool.id && styles.cardSelected]}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{pool.name}</Text>
                  <Text style={styles.apy}>{(pool.supplyApy * 100).toFixed(2)}% APY</Text>
                </View>
                <Text style={styles.cardMeta}>
                  Total liquidity {Number(toUnits(pool.totalSupply, 2)).toLocaleString()}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    setSelectedPool(pool);
                    setStep('deposit-form');
                  }}
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.primaryButtonText}>Deposit &amp; earn</Text>
                </Pressable>
              </View>
            ))
          )}
        </View>
      ) : null}

      {step === 'deposit-form' && selectedPool ? (
        <View style={styles.section}>
          <View style={styles.card}>
            <Text style={styles.cardMeta}>
              {selectedPool.name} · est. APY {(selectedPool.supplyApy * 100).toFixed(2)}%
            </Text>
            <View style={styles.amountRow}>
              <TextInput
                style={styles.amountInput}
                value={depositAmount}
                onChangeText={setDepositAmount}
                placeholder="0.00"
                placeholderTextColor="rgba(246,247,248,0.3)"
                keyboardType="decimal-pad"
                accessibilityLabel="Deposit amount"
              />
              <Text style={styles.cardMeta}>{selectedPool.assets[0]?.slice(0, 6) ?? 'asset'}</Text>
            </View>
            {depositAmount ? (
              <Text style={styles.cardMeta}>
                Est. earned in 1 year{' '}
                <Text style={styles.accent}>
                  {((parseFloat(depositAmount) || 0) * selectedPool.supplyApy).toFixed(4)}
                </Text>
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !depositIsValid }}
            disabled={!depositIsValid}
            onPress={handleDeposit}
            style={({ pressed }) => [
              styles.primaryButton,
              !depositIsValid && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Deposit &amp; earn</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setStep('pools')}
            style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
          >
            <Text style={styles.ghostButtonText}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      {step === 'withdraw-form' && selectedPosition ? (
        <View style={styles.section}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              Withdraw from pool {selectedPosition.poolId.slice(0, 8)}…
            </Text>
            <Row label="Deposited" value={toUnits(selectedPosition.deposited, 4)} />
            <Row
              label="Accrued interest"
              value={`+${toUnits(selectedPosition.accruedInterest, 6)}`}
              accent
            />
            <Text style={styles.cardMeta}>All bTokens are redeemed for the underlying asset.</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={handleWithdraw}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.primaryButtonText}>Withdraw all</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setStep('pools')}
            style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
          >
            <Text style={styles.ghostButtonText}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      {step === 'depositing' || step === 'withdrawing' ? (
        <View style={[styles.card, styles.centeredCard]}>
          <ActivityIndicator color={colors.gold} />
          <Text style={styles.cardTitle}>Waiting for passkey…</Text>
          <Text style={styles.cardMeta}>Approve with Face ID or fingerprint to continue.</Text>
        </View>
      ) : null}

      {step === 'deposit-done' || step === 'withdraw-done' ? (
        <View style={[styles.card, styles.centeredCard]}>
          <Text style={styles.successMark}>✓</Text>
          <Text style={styles.cardTitle}>
            {step === 'deposit-done' ? 'Deposit successful' : 'Withdrawal successful'}
          </Text>
          {txHash ? <Text style={styles.hash}>{txHash}</Text> : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setStep('pools');
              setTxHash(null);
            }}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.primaryButtonText}>Back to Earn</Text>
          </Pressable>
        </View>
      ) : null}

      {step === 'error' ? (
        <View style={[styles.card, styles.centeredCard]}>
          <Text style={styles.errorMark}>!</Text>
          <Text style={styles.cardTitle}>Transaction failed</Text>
          {errorMsg ? <Text style={styles.cardMeta}>{errorMsg}</Text> : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => setStep('pools')}
            style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
          >
            <Text style={styles.ghostButtonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </ScreenScaffold>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, accent && styles.accent]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10, marginTop: 12 },
  sectionLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  card: {
    padding: 18,
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: 8,
  },
  cardSelected: { borderColor: colors.gold },
  centeredCard: { alignItems: 'center', marginTop: 12 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  cardTitle: { color: colors.offWhite, fontSize: 17, fontWeight: '600' },
  cardMeta: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  apy: { color: colors.gold, fontSize: 13, fontWeight: '700' },
  accent: { color: colors.teal },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  rowLabel: { color: colors.muted, fontSize: 13 },
  rowValue: { color: colors.offWhite, fontSize: 14, textAlign: 'right' },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  amountInput: {
    flex: 1,
    color: colors.offWhite,
    fontSize: 26,
    paddingVertical: 6,
  },
  primaryButton: {
    marginTop: 6,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 100,
    backgroundColor: colors.gold,
  },
  primaryButtonText: { color: colors.bg, fontSize: 15, fontWeight: '700' },
  ghostButton: {
    marginTop: 6,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 100,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  ghostButtonText: { color: colors.offWhite, fontSize: 14, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  centered: { paddingVertical: 24, alignItems: 'center' },
  successMark: { color: colors.teal, fontSize: 34, fontWeight: '700' },
  errorMark: { color: colors.danger, fontSize: 34, fontWeight: '700' },
  hash: {
    color: colors.muted,
    fontSize: 11,
    textAlign: 'center',
  },
});
