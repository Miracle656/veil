import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
import { SlideToConfirm } from '../components/SlideToConfirm';
import { SuccessAnimation } from '../components/SuccessAnimation';
import { useTheme } from '../hooks/useTheme';
import { useNetwork } from '../hooks/useNetwork';
import { useWallet } from '../components/WalletProvider';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { errorMessage } from '../lib/errorMessage';
import { getFeePayerAddress } from '../lib/activity';
import { loadHoldings } from '../lib/holdings';
import { loadSoroswapLpPositions, type LpPosition } from '../lib/soroswapLpPositions';
import {
  DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
  HIGH_LIQUIDITY_SLIPPAGE_BPS,
  buildAddLiquidityArgs,
  buildPairTokenTransferArgs,
  buildRemoveLiquidityArgs,
  estimateAddLiquidity,
  estimateRemoveLiquidity,
  formatLiquidityAmount,
  parseLiquidityAmount,
  parseSlippagePercent,
  readLiquidityAssetBalance,
  readLpBalance,
  readSoroswapPair,
  readSoroswapPairById,
  slippageFailureMessage,
  soroswapRouterId,
  type PairLookup,
  type SoroswapPairState,
} from '../lib/soroswapLiquidity';
import { invokeAsWallet } from '../lib/contractInvoke';
import { deployWalletIfNeeded } from '../lib/deployWallet';
import { getWalletAddress } from '../lib/walletStore';
import { swapAssetKey, swapAssetLabel, swapDestinations, type NetworkName, type SwapAsset } from '../lib/swapAssets';

type Token = SwapAsset & { label: string };
type Mode = 'add' | 'remove';
type Step = 'form' | 'review' | 'signing' | 'done' | 'error';
type AssetBalances = { a: bigint; b: bigint };
type PositionBalances = Record<string, bigint>;

function tokenLabel(asset: SwapAsset): string {
  return asset.issuer ? asset.code : 'XLM';
}

function tokensFor(network: NetworkName, holdings: Awaited<ReturnType<typeof loadHoldings>> = []): Token[] {
  const options = new Map<string, Token>();
  const add = (asset: SwapAsset) => {
    const key = swapAssetKey(asset);
    if (options.has(key)) return;
    options.set(key, { ...asset, label: tokenLabel(asset) });
  };

  swapDestinations(network).forEach(add);
  holdings.forEach((holding) => add({ code: holding.code, issuer: holding.issuer }));
  return [...options.values()];
}

function samePairState(a: SoroswapPairState, b: SoroswapPairState): boolean {
  return (
    a.pairId === b.pairId &&
    a.reserveA === b.reserveA &&
    a.reserveB === b.reserveB &&
    a.balanceA === b.balanceA &&
    a.balanceB === b.balanceB &&
    a.totalSupply === b.totalSupply &&
    a.kLast === b.kLast &&
    a.feesEnabled === b.feesEnabled
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSlippage(bps: number): string {
  return (bps / 100).toFixed(2);
}

export default function PoolsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { networkName } = useNetwork();
  const { wallet } = useWallet();
  const [mode, setMode] = useState<Mode>('add');
  const [step, setStep] = useState<Step>('form');
  const [tokens, setTokens] = useState<Token[]>(() => tokensFor(networkName));
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [feePayerAddress, setFeePayerAddress] = useState<string | null>(null);
  const [positions, setPositions] = useState<LpPosition[]>([]);
  const [positionsLoaded, setPositionsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assetA, setAssetA] = useState<Token | null>(null);
  const [assetB, setAssetB] = useState<Token | null>(null);
  const [assetPicker, setAssetPicker] = useState<'a' | 'b' | null>(null);
  const [pairLookup, setPairLookup] = useState<PairLookup | null>(null);
  const [pairLoading, setPairLoading] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [balanceRows, setBalanceRows] = useState<Record<string, AssetBalances> | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [amountAInput, setAmountAInput] = useState('');
  const [slippageInput, setSlippageInput] = useState(
    formatSlippage(DEFAULT_LIQUIDITY_SLIPPAGE_BPS),
  );
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);
  const [removePair, setRemovePair] = useState<SoroswapPairState | null>(null);
  const [removeBalances, setRemoveBalances] = useState<PositionBalances>({});
  const [removeAmountInput, setRemoveAmountInput] = useState('');
  const [removeLoading, setRemoveLoading] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [operationLabel, setOperationLabel] = useState('');
  const [transactionHash, setTransactionHash] = useState<string | null>(null);

  const refreshDiscovery = useCallback(async () => {
    setLoadError(null);
    setPositionsLoaded(false);
    try {
      const address = await getWalletAddress();
      if (!address) {
        setLoadError('Set up a wallet before adding or removing liquidity.');
        return;
      }
      const payer = await getFeePayerAddress();
      setWalletAddress(address);
      setFeePayerAddress(payer);
      if (!payer) {
        setLoadError('No spending account is available to sign Soroswap transactions.');
      }

      const [holdingsResult, positionsResult] = await Promise.allSettled([
        loadHoldings(address),
        loadSoroswapLpPositions(address),
      ]);
      if (holdingsResult.status === 'fulfilled') {
        setTokens(tokensFor(networkName, holdingsResult.value));
      } else {
        setLoadError(`Could not read wallet holdings: ${errorText(holdingsResult.reason)}`);
      }
      if (positionsResult.status === 'fulfilled') {
        setPositions(positionsResult.value);
        setSelectedPairId((current) =>
          current && positionsResult.value.some((position) => position.pairId === current)
            ? current
            : positionsResult.value[0]?.pairId ?? null,
        );
      } else {
        setRemoveError(`Could not read LP positions: ${errorText(positionsResult.reason)}`);
      }
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setPositionsLoaded(true);
    }
  }, [networkName]);

  useEffect(() => {
    void refreshDiscovery();
  }, [refreshDiscovery]);

  useEffect(() => {
    const next = tokensFor(networkName);
    setTokens(next);
    setAssetA(next[0] ?? null);
    setAssetB(next.find((token) => !next[0] || swapAssetKey(token) !== swapAssetKey(next[0])) ?? null);
    setPairLookup(null);
    setBalanceRows(null);
  }, [networkName]);

  useEffect(() => {
    if (mode !== 'add' || !assetA || !assetB) return;
    let active = true;
    setPairLookup(null);
    setPairError(null);
    setBalanceRows(null);
    setPairLoading(true);
    if (swapAssetKey(assetA) === swapAssetKey(assetB)) {
      setPairError('Choose two different assets.');
      setPairLoading(false);
      return;
    }
    void readSoroswapPair(assetA, assetB)
      .then((result) => {
        if (active) setPairLookup(result);
      })
      .catch((error) => {
        if (active) setPairError(errorMessage(error));
      })
      .finally(() => {
        if (active) setPairLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mode, assetA, assetB, networkName]);

  useEffect(() => {
    if (
      mode !== 'add' ||
      pairLookup?.kind !== 'found' ||
      !assetA ||
      !assetB ||
      !walletAddress
    ) {
      setBalanceRows(null);
      return;
    }
    let active = true;
    const owners = [...new Set([walletAddress, feePayerAddress].filter((value): value is string => !!value))];
    setBalanceRows(null);
    setBalanceError(null);
    setBalanceLoading(true);
    void Promise.all(
      owners.map(async (owner) => {
        const [a, b] = await Promise.all([
          readLiquidityAssetBalance(owner, assetA),
          readLiquidityAssetBalance(owner, assetB),
        ]);
        return [owner, { a, b }] as const;
      }),
    )
      .then((rows) => {
        if (active) setBalanceRows(Object.fromEntries(rows));
      })
      .catch((error) => {
        if (active) setBalanceError(`Could not read asset balances: ${errorText(error)}`);
      })
      .finally(() => {
        if (active) setBalanceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mode, pairLookup, assetA, assetB, walletAddress, feePayerAddress]);

  const selectedPosition = positions.find((position) => position.pairId === selectedPairId) ?? null;

  useEffect(() => {
    if (mode !== 'remove' || !selectedPosition) {
      setRemovePair(null);
      setRemoveBalances({});
      return;
    }
    let active = true;
    setRemovePair(null);
    setRemoveError(null);
    setRemoveLoading(true);
    void Promise.all([
      readSoroswapPairById(
        selectedPosition.pairId,
        selectedPosition.tokenAId,
        selectedPosition.tokenBId,
      ),
      Promise.all(
        selectedPosition.ownerBalances.map(async ({ address }) => [
          address,
          await readLpBalance(selectedPosition.pairId, address),
        ] as const),
      ),
    ])
      .then(([pair, balances]) => {
        if (!active) return;
        setRemovePair(pair);
        setRemoveBalances(Object.fromEntries(balances));
      })
      .catch((error) => {
        if (active) setRemoveError(errorMessage(error));
      })
      .finally(() => {
        if (active) setRemoveLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mode, selectedPosition]);

  const slippage = useMemo(() => {
    try {
      return { bps: parseSlippagePercent(slippageInput), error: null };
    } catch (error) {
      return { bps: null, error: errorText(error) };
    }
  }, [slippageInput]);

  const addPair = pairLookup?.kind === 'found' ? pairLookup.pair : null;
  const parsedAddAmount = useMemo(() => {
    if (!addPair || !amountAInput.trim()) return null;
    try {
      return { amount: parseLiquidityAmount(amountAInput, addPair.decimalsA), error: null };
    } catch (error) {
      return { amount: null, error: errorText(error) };
    }
  }, [addPair, amountAInput]);
  const addEstimate = useMemo(() => {
    if (!addPair || !parsedAddAmount?.amount || slippage.bps === null) return null;
    try {
      return {
        estimate: estimateAddLiquidity(addPair, parsedAddAmount.amount, slippage.bps),
        error: null,
      };
    } catch (error) {
      return { estimate: null, error: errorText(error) };
    }
  }, [addPair, parsedAddAmount, slippage.bps]);
  const availableA = Object.values(balanceRows ?? {}).reduce((total, row) => total + row.a, 0n);
  const availableB = Object.values(balanceRows ?? {}).reduce((total, row) => total + row.b, 0n);
  const addShortage = (() => {
    if (!addPair || !parsedAddAmount?.amount || !addEstimate?.estimate || !balanceRows) return null;
    if (parsedAddAmount.amount > availableA) {
      const missing = parsedAddAmount.amount - availableA;
      return `You are short ${formatLiquidityAmount(missing, addPair.decimalsA)} ${assetA?.label ?? 'asset'} for this deposit. Reduce the amount, add that asset to your wallet, or swap some ${assetB?.label ?? 'other asset'} into it first. Veil will not swap it for you here.`;
    }
    if (addEstimate.estimate.amountB > availableB) {
      const missing = addEstimate.estimate.amountB - availableB;
      return `You are short ${formatLiquidityAmount(missing, addPair.decimalsB)} ${assetB?.label ?? 'asset'}. You need ${formatLiquidityAmount(addEstimate.estimate.amountB, addPair.decimalsB)} ${assetB?.label ?? 'asset'} at this pool ratio; swap some ${assetA?.label ?? 'asset'} into ${assetB?.label ?? 'asset'} first. Veil will not swap it for you here.`;
    }
    return null;
  })();

  const removeAvailable = Object.values(removeBalances).reduce((total, amount) => total + amount, 0n);
  const parsedRemoveAmount = useMemo(() => {
    if (!removePair || !removeAmountInput.trim()) return null;
    try {
      return { amount: parseLiquidityAmount(removeAmountInput, removePair.lpDecimals), error: null };
    } catch (error) {
      return { amount: null, error: errorText(error) };
    }
  }, [removePair, removeAmountInput]);
  const removeEstimate = useMemo(() => {
    if (!removePair || !parsedRemoveAmount?.amount || slippage.bps === null) return null;
    try {
      return {
        estimate: estimateRemoveLiquidity(
          removePair,
          parsedRemoveAmount.amount,
          removeAvailable,
          slippage.bps,
        ),
        error: null,
      };
    } catch (error) {
      return { estimate: null, error: errorText(error) };
    }
  }, [removePair, parsedRemoveAmount, removeAvailable, slippage.bps]);

  const canReviewAdd = !!(
    addPair &&
    addEstimate?.estimate &&
    balanceRows &&
    !!feePayerAddress &&
    !addShortage &&
    !pairLoading &&
    !balanceLoading &&
    !pairError &&
    !balanceError &&
    slippage.bps !== null
  );
  const canReviewRemove = !!(
    removePair &&
    removeEstimate?.estimate &&
    selectedPosition &&
    !!feePayerAddress &&
    !removeLoading &&
    !removeError &&
    slippage.bps !== null
  );

  const chooseAsset = (selected: Token) => {
    if (assetPicker === 'a') {
      if (assetB && swapAssetKey(selected) === swapAssetKey(assetB)) setAssetB(assetA);
      setAssetA(selected);
    } else if (assetPicker === 'b') {
      if (assetA && swapAssetKey(selected) === swapAssetKey(assetA)) setAssetA(assetB);
      setAssetB(selected);
    }
    setAssetPicker(null);
  };

  const refreshPositions = useCallback(async () => {
    if (!walletAddress) return;
    const next = await loadSoroswapLpPositions(walletAddress);
    setPositions(next);
    setSelectedPairId((current) =>
      current && next.some((position) => position.pairId === current)
        ? current
        : next[0]?.pairId ?? null,
    );
  }, [walletAddress]);

  const enterReview = () => {
    if ((mode === 'add' && !canReviewAdd) || (mode === 'remove' && !canReviewRemove)) return;
    setExecutionError(null);
    setStep('review');
  };

  const setFormError = (message: string) => {
    setExecutionError(message);
    setStep('form');
  };

  const confirmAdd = async () => {
    if (!assetA || !assetB || !addPair || !parsedAddAmount?.amount || !slippage.bps) return;
    setStep('signing');
    setOperationLabel('Refreshing pool data');
    setExecutionError(null);
    try {
      const latest = await readSoroswapPair(assetA, assetB);
      if (latest.kind === 'missing') {
        setPairLookup(latest);
        setFormError('This Soroswap pair is no longer available. No transaction was built.');
        return;
      }
      if (!samePairState(addPair, latest.pair)) {
        setPairLookup(latest);
        setFormError('The pool changed after your review. Check the updated amounts and confirm again.');
        return;
      }
      const estimate = estimateAddLiquidity(latest.pair, parsedAddAmount.amount, slippage.bps);
      const owners = [...new Set([walletAddress, feePayerAddress].filter((value): value is string => !!value))];
      const rows = await Promise.all(
        owners.map(async (owner) => {
          const [a, b] = await Promise.all([
            readLiquidityAssetBalance(owner, assetA),
            readLiquidityAssetBalance(owner, assetB),
          ]);
          return [owner, { a, b }] as const;
        }),
      );
      const freshBalances = Object.fromEntries(rows) as Record<string, AssetBalances>;
      const totalA = rows.reduce((total, [, row]) => total + row.a, 0n);
      const totalB = rows.reduce((total, [, row]) => total + row.b, 0n);
      if (estimate.amountA > totalA || estimate.amountB > totalB) {
        setBalanceRows(freshBalances);
        setFormError('Your available balance changed. Review the shortfall before continuing.');
        return;
      }

      const recipient = walletAddress?.startsWith('C') ? walletAddress : feePayerAddress;
      if (!recipient) throw new Error('No wallet address is available to receive the LP tokens.');
      if (walletAddress?.startsWith('C')) {
        setOperationLabel('Preparing your smart wallet');
        await deployWalletIfNeeded(wallet.deploy, walletAddress);
      }
      const target = walletAddress?.startsWith('C') ? walletAddress : recipient;
      const feePayerRow = feePayerAddress ? freshBalances[feePayerAddress] : undefined;
      const targetRow = freshBalances[target];
      const shortA = estimate.amountA > (targetRow?.a ?? 0n) ? estimate.amountA - (targetRow?.a ?? 0n) : 0n;
      const shortB = estimate.amountB > (targetRow?.b ?? 0n) ? estimate.amountB - (targetRow?.b ?? 0n) : 0n;
      if ((shortA > 0n || shortB > 0n) && !feePayerAddress) {
        throw new Error('A spending account is needed to move the selected assets into the wallet.');
      }
      if (shortA > 0n && feePayerAddress && feePayerAddress !== target) {
        if (shortA > (feePayerRow?.a ?? 0n)) throw new Error('The spending account does not hold enough of the first asset.');
        setOperationLabel(`Moving ${assetA.label} into your smart wallet`);
        await invokeAsWallet(
          latest.pair.tokenAId,
          'transfer',
          buildPairTokenTransferArgs({ from: feePayerAddress, to: target, amount: shortA }).args,
        );
      }
      if (shortB > 0n && feePayerAddress && feePayerAddress !== target) {
        if (shortB > (feePayerRow?.b ?? 0n)) throw new Error('The spending account does not hold enough of the second asset.');
        setOperationLabel(`Moving ${assetB.label} into your smart wallet`);
        await invokeAsWallet(
          latest.pair.tokenBId,
          'transfer',
          buildPairTokenTransferArgs({ from: feePayerAddress, to: target, amount: shortB }).args,
        );
      }
      const call = buildAddLiquidityArgs({
        assetA: latest.pair.tokenAId,
        assetB: latest.pair.tokenBId,
        amountA: estimate.amountA,
        amountB: estimate.amountB,
        minimumA: estimate.minimumA,
        minimumB: estimate.minimumB,
        recipient,
      });
      setOperationLabel('Signing and adding liquidity');
      const hash = await invokeAsWallet(soroswapRouterId(), call.method, call.args);
      setTransactionHash(hash);
      setStep('done');
    } catch (error) {
      setExecutionError(
        slippageFailureMessage(error) ?? errorMessage(error),
      );
      setStep('error');
    }
  };

  const confirmRemove = async () => {
    if (!selectedPosition || !removePair || !parsedRemoveAmount?.amount || !slippage.bps) return;
    setStep('signing');
    setOperationLabel('Refreshing pool data');
    setExecutionError(null);
    try {
      const latest = await readSoroswapPairById(
        selectedPosition.pairId,
        selectedPosition.tokenAId,
        selectedPosition.tokenBId,
      );
      if (!samePairState(removePair, latest)) {
        setRemovePair(latest);
        setFormError('The pool changed after your review. Check the updated amounts and confirm again.');
        return;
      }
      const owners = [...new Set([walletAddress, feePayerAddress].filter((value): value is string => !!value))];
      const currentLpBalances = await Promise.all(
        owners.map(async (owner) => [owner, await readLpBalance(latest.pairId, owner)] as const),
      );
      const available = currentLpBalances.reduce((total, [, amount]) => total + amount, 0n);
      if (parsedRemoveAmount.amount > available) {
        setRemoveBalances(Object.fromEntries(currentLpBalances));
        setFormError('Your LP token balance changed. Update the amount before continuing.');
        return;
      }
      const estimate = estimateRemoveLiquidity(
        latest,
        parsedRemoveAmount.amount,
        available,
        slippage.bps,
      );
      const recipient = walletAddress?.startsWith('C') ? walletAddress : feePayerAddress;
      if (!recipient) throw new Error('No wallet address is available to receive the underlying assets.');
      if (walletAddress?.startsWith('C')) {
        setOperationLabel('Preparing your smart wallet');
        await deployWalletIfNeeded(wallet.deploy, walletAddress);
      }
      const target = walletAddress?.startsWith('C') ? walletAddress : recipient;
      const targetBalance = currentLpBalances.find(([owner]) => owner === target)?.[1] ?? 0n;
      const shortfall = estimate.liquidity > targetBalance ? estimate.liquidity - targetBalance : 0n;
      const sourceBalance = feePayerAddress
        ? currentLpBalances.find(([owner]) => owner === feePayerAddress)?.[1] ?? 0n
        : 0n;
      if (shortfall > sourceBalance || (shortfall > 0n && feePayerAddress === target)) {
        throw new Error('The spending account does not hold enough of this LP position.');
      }

      if (shortfall > 0n && feePayerAddress) {
        setOperationLabel('Moving LP tokens into your smart wallet');
        await invokeAsWallet(
          selectedPosition.pairId,
          'transfer',
          buildPairTokenTransferArgs({
            from: feePayerAddress,
            to: target,
            amount: shortfall,
          }).args,
        );
      }
      const call = buildRemoveLiquidityArgs({
        assetA: latest.tokenAId,
        assetB: latest.tokenBId,
        liquidity: estimate.liquidity,
        minimumA: estimate.minimumA,
        minimumB: estimate.minimumB,
        recipient,
      });
      setOperationLabel('Signing and removing liquidity');
      const hash = await invokeAsWallet(soroswapRouterId(), call.method, call.args);
      setTransactionHash(hash);
      setStep('done');
      void refreshPositions().catch((error) =>
        setRemoveError(`Could not refresh LP positions: ${errorText(error)}`),
      );
    } catch (error) {
      setExecutionError(slippageFailureMessage(error) ?? errorMessage(error));
      setStep('error');
    }
  };

  const retry = () => {
    setExecutionError(null);
    setStep('form');
    if (mode === 'add' && assetA && assetB) {
      setPairLookup(null);
      setPairError(null);
      setPairLoading(true);
      void readSoroswapPair(assetA, assetB)
        .then(setPairLookup)
        .catch((error) => setPairError(errorMessage(error)))
        .finally(() => setPairLoading(false));
    }
    if (mode === 'remove') {
      void refreshPositions().catch((error) => setRemoveError(errorText(error)));
    }
  };

  const quickRemove = (percent: bigint) => {
    if (!removePair || removeAvailable <= 0n) return;
    setRemoveAmountInput(formatLiquidityAmount((removeAvailable * percent) / 100n, removePair.lpDecimals));
  };

  const activeError = executionError;

  return (
    <SafeAreaView style={styles.screen}>
      <FlowHeader
        title={
          step === 'review'
            ? `Review ${mode === 'add' ? 'add' : 'removal'}`
            : step === 'done'
              ? 'Liquidity complete'
              : 'Liquidity'
        }
        onBack={step === 'review' || step === 'error' ? () => setStep('form') : undefined}
      />

      {step === 'signing' ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={styles.body}>{operationLabel}</Text>
          <Text style={styles.muted}>Your assets move only as part of the confirmed transaction.</Text>
        </View>
      ) : step === 'done' ? (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.successCard}>
            <SuccessAnimation
              title="Liquidity confirmed"
              subtitle={mode === 'add' ? 'LP tokens are in your wallet.' : 'Both pool assets are in your wallet.'}
            />
            <Text style={styles.heading}>Liquidity transaction confirmed</Text>
            <Text style={styles.body}>
              {mode === 'add'
                ? 'Your LP tokens are now in your wallet.'
                : 'Both underlying assets are now in your wallet.'}
            </Text>
            {transactionHash ? <Text selectable style={styles.hash}>{transactionHash}</Text> : null}
            <ActionButton
              label="Done"
              onPress={() => {
                setStep('form');
                setTransactionHash(null);
                setAmountAInput('');
                setRemoveAmountInput('');
                void refreshDiscovery();
              }}
            />
          </View>
        </ScrollView>
      ) : step === 'review' ? (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.subtitle}>Review the exact amounts and minimums before signing.</Text>
          {mode === 'add' && addPair && addEstimate?.estimate && assetA && assetB ? (
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>YOU WILL ADD</Text>
              <Text style={styles.reviewAmount}>
                {formatLiquidityAmount(addEstimate.estimate.amountA, addPair.decimalsA)} {assetA.label}
              </Text>
              <Text style={styles.reviewAmount}>
                {formatLiquidityAmount(addEstimate.estimate.amountB, addPair.decimalsB)} {assetB.label}
              </Text>
              <Divider styles={styles} />
              <Text style={styles.sectionLabel}>ESTIMATED LP TOKENS TO RECEIVE</Text>
              <Text style={styles.body}>
                {formatLiquidityAmount(addEstimate.estimate.liquidity, addPair.lpDecimals)} LP
              </Text>
              <Text style={styles.muted}>
                Estimated pool share: {addEstimate.estimate.poolSharePercent}%. The estimate can change before the transaction lands.
              </Text>
              <Divider styles={styles} />
              <Text style={styles.sectionLabel}>MINIMUM AMOUNTS ACCEPTED</Text>
              <Text style={styles.body}>
                {formatLiquidityAmount(addEstimate.estimate.minimumA, addPair.decimalsA)} {assetA.label}
                {' + '}
                {formatLiquidityAmount(addEstimate.estimate.minimumB, addPair.decimalsB)} {assetB.label}
              </Text>
              <Text style={styles.muted}>The router accepts minimum amounts for both assets, not a minimum LP-token amount.</Text>
              {walletAddress?.startsWith('C') && feePayerAddress && balanceRows ? (
                <Text style={styles.muted}>
                  If funds are held in the spending account, they move to your smart wallet first. If the add cannot complete, they remain there; no swap is made.
                </Text>
              ) : null}
            </View>
          ) : mode === 'remove' && removePair && removeEstimate?.estimate && selectedPosition ? (
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>YOU WILL REMOVE</Text>
              <Text style={styles.reviewAmount}>
                {formatLiquidityAmount(removeEstimate.estimate.liquidity, removePair.lpDecimals)} LP
              </Text>
              <Divider styles={styles} />
              <Text style={styles.sectionLabel}>ESTIMATED ASSETS RETURNED</Text>
              <Text style={styles.reviewAmount}>
                {formatLiquidityAmount(removeEstimate.estimate.amountA, removePair.decimalsA)} {selectedPosition.tokenA}
              </Text>
              <Text style={styles.reviewAmount}>
                {formatLiquidityAmount(removeEstimate.estimate.amountB, removePair.decimalsB)} {selectedPosition.tokenB}
              </Text>
              <Text style={styles.muted}>
                Removing returns both assets in the pool&apos;s current ratio, which may differ from what you added.
              </Text>
              <Divider styles={styles} />
              <Text style={styles.sectionLabel}>MINIMUM AMOUNTS ACCEPTED</Text>
              <Text style={styles.body}>
                {formatLiquidityAmount(removeEstimate.estimate.minimumA, removePair.decimalsA)} {selectedPosition.tokenA}
                {' + '}
                {formatLiquidityAmount(removeEstimate.estimate.minimumB, removePair.decimalsB)} {selectedPosition.tokenB}
              </Text>
              <Text style={styles.muted}>The router returns both assets to your wallet in this transaction.</Text>
              {walletAddress?.startsWith('C') && feePayerAddress ? (
                <Text style={styles.muted}>
                  LP tokens held in the spending account move to your smart wallet first. If removal cannot complete, they remain there.
                </Text>
              ) : null}
            </View>
          ) : (
            <InfoCard styles={styles} message="The quote is no longer available. Return to the form and refresh it." />
          )}
          {activeError ? <InfoCard styles={styles} message={activeError} error /> : null}
          <SlideToConfirm
            label={mode === 'add' ? 'Slide to add liquidity' : 'Slide to remove liquidity'}
            onConfirm={() => void (mode === 'add' ? confirmAdd() : confirmRemove())}
            disabled={mode === 'add' ? !canReviewAdd : !canReviewRemove}
            testID="liquidity-confirm"
          />
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.subtitle}>
            Add liquidity to an existing Soroswap pair or remove LP tokens held by this wallet.
          </Text>

          <View style={styles.modeTabs}>
            {(['add', 'remove'] as const).map((nextMode) => (
              <Pressable
                key={nextMode}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === nextMode }}
                onPress={() => {
                  setMode(nextMode);
                  setExecutionError(null);
                }}
                style={[styles.modeTab, mode === nextMode && styles.modeTabActive]}
                testID={`liquidity-mode-${nextMode}`}
              >
                <Text style={[styles.modeTabText, mode === nextMode && styles.modeTabTextActive]}>
                  {nextMode === 'add' ? 'Add' : 'Remove'}
                </Text>
              </Pressable>
            ))}
          </View>

          {loadError ? <InfoCard styles={styles} message={loadError} error /> : null}
          {activeError ? (
            <InfoCard styles={styles} message={activeError} error testID="liquidity-error" />
          ) : null}

          {mode === 'add' ? (
            <>
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>PAIR</Text>
                <View style={styles.pairRow}>
                  <AssetChoice
                    label={assetA?.label ?? 'Choose asset'}
                    detail={assetA ? swapAssetLabel(assetA, networkName) : 'Select first asset'}
                    styles={styles}
                    onPress={() => setAssetPicker('a')}
                    testID="liquidity-asset-a"
                  />
                  <Text style={styles.pairSlash}>/</Text>
                  <AssetChoice
                    label={assetB?.label ?? 'Choose asset'}
                    detail={assetB ? swapAssetLabel(assetB, networkName) : 'Select second asset'}
                    styles={styles}
                    onPress={() => setAssetPicker('b')}
                    testID="liquidity-asset-b"
                  />
                </View>

                <Text style={styles.sectionLabel}>AMOUNT</Text>
                <TextInput
                  accessibilityLabel={`${assetA?.label ?? 'First asset'} amount`}
                  keyboardType="decimal-pad"
                  onChangeText={setAmountAInput}
                  placeholder="0"
                  placeholderTextColor={colors.textFaint}
                  style={styles.input}
                  testID="liquidity-amount-a"
                  value={amountAInput}
                />
                {assetA ? (
                  <Text style={styles.muted}>Available: {formatLiquidityAmount(availableA, addPair?.decimalsA ?? 7)} {assetA.label}</Text>
                ) : null}
                {pairLoading ? <ActivityIndicator color={colors.accent} /> : null}
                {pairError ? <InfoCard styles={styles} message={pairError} error /> : null}
                {pairLookup?.kind === 'missing' ? (
                  <InfoCard
                    styles={styles}
                    message={`Soroswap does not have a ${assetA?.label ?? ''}/${assetB?.label ?? ''} pair. This screen cannot create a pair, so no transaction is available.`}
                    testID="liquidity-pair-missing"
                  />
                ) : null}
                {pairLookup?.kind === 'found' && addEstimate?.estimate && assetB ? (
                  <Text style={styles.derived} testID="liquidity-counter-amount">
                    Required at current reserves: {formatLiquidityAmount(addEstimate.estimate.amountB, addPair?.decimalsB)} {assetB.label}
                  </Text>
                ) : null}
                {parsedAddAmount?.error ? <InfoCard styles={styles} message={parsedAddAmount.error} error /> : null}
                {addEstimate?.error ? <InfoCard styles={styles} message={addEstimate.error} error /> : null}
                {balanceLoading ? <ActivityIndicator color={colors.accent} /> : null}
                {balanceError ? <InfoCard styles={styles} message={balanceError} error /> : null}
                {addShortage ? <InfoCard styles={styles} message={addShortage} error testID="liquidity-shortage" /> : null}
                {pairLookup?.kind === 'found' && addPair?.reserveA === 0n ? (
                  <InfoCard styles={styles} message="This pool is empty. First-liquidity deposits are not supported here." error />
                ) : null}
                <Text style={styles.impactCopy} testID="liquidity-impact-warning">
                  Providing liquidity changes the ratio of what you hold as prices move, and you can end up with less value than if you had simply held the two assets.
                </Text>
              </View>
              <SlippageInput
                colors={colors}
                error={slippage.error}
                input={slippageInput}
                onChange={setSlippageInput}
                styles={styles}
                warning={slippage.bps !== null && slippage.bps > HIGH_LIQUIDITY_SLIPPAGE_BPS}
              />
              <ActionButton
                disabled={!canReviewAdd}
                label="Review add"
                onPress={enterReview}
                styles={styles}
                testID="liquidity-review-button"
              />
            </>
          ) : (
            <>
              <View style={styles.card}>
                <Text style={styles.sectionLabel}>YOUR LP POSITIONS</Text>
                {!positionsLoaded || removeLoading ? <ActivityIndicator color={colors.accent} /> : null}
                {positionsLoaded && positions.length === 0 ? (
                  <Text style={styles.muted}>No Soroswap LP tokens were found in this wallet.</Text>
                ) : null}
                {positions.map((position) => (
                  <Pressable
                    key={position.pairId}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selectedPairId === position.pairId }}
                    onPress={() => {
                      setSelectedPairId(position.pairId);
                      setRemoveAmountInput('');
                    }}
                    style={[
                      styles.positionChoice,
                      selectedPairId === position.pairId && styles.positionChoiceActive,
                    ]}
                    testID={`liquidity-position-${position.pairId}`}
                  >
                    <Text style={styles.body}>{position.tokenA}/{position.tokenB}</Text>
                    <Text style={styles.muted}>{position.lpBalance} LP tokens</Text>
                  </Pressable>
                ))}
                {removeError ? <InfoCard styles={styles} message={removeError} error /> : null}
                {selectedPosition && removePair ? (
                  <>
                    <Text style={styles.sectionLabel}>LP TOKEN AMOUNT</Text>
                    <TextInput
                      accessibilityLabel="LP token amount"
                      keyboardType="decimal-pad"
                      onChangeText={setRemoveAmountInput}
                      placeholder="0"
                      placeholderTextColor={colors.textFaint}
                      style={styles.input}
                      testID="liquidity-remove-amount"
                      value={removeAmountInput}
                    />
                    <Text style={styles.muted}>
                      Available: {formatLiquidityAmount(removeAvailable, removePair.lpDecimals)} LP
                    </Text>
                    <View style={styles.quickRow}>
                      {[25n, 50n, 75n, 100n].map((percent) => (
                        <Pressable
                          key={percent.toString()}
                          onPress={() => quickRemove(percent)}
                          style={styles.quickButton}
                          testID={`liquidity-remove-${percent.toString()}`}
                        >
                          <Text style={styles.quickText}>{percent === 100n ? 'Max' : `${percent}%`}</Text>
                        </Pressable>
                      ))}
                    </View>
                    {removeEstimate?.error ? <InfoCard styles={styles} message={removeEstimate.error} error /> : null}
                    {removeEstimate?.estimate ? (
                      <Text style={styles.derived} testID="liquidity-remove-estimate">
                        Estimated: {formatLiquidityAmount(removeEstimate.estimate.amountA, removePair.decimalsA)} {selectedPosition.tokenA}
                        {' + '}
                        {formatLiquidityAmount(removeEstimate.estimate.amountB, removePair.decimalsB)} {selectedPosition.tokenB}
                      </Text>
                    ) : null}
                  </>
                ) : null}
              </View>
              <SlippageInput
                colors={colors}
                error={slippage.error}
                input={slippageInput}
                onChange={setSlippageInput}
                styles={styles}
                warning={slippage.bps !== null && slippage.bps > HIGH_LIQUIDITY_SLIPPAGE_BPS}
              />
              <ActionButton
                disabled={!canReviewRemove}
                label="Review removal"
                onPress={enterReview}
                styles={styles}
                testID="liquidity-review-button"
              />
            </>
          )}

          {step === 'error' ? (
            <ActionButton
              label="Refresh quote"
              onPress={retry}
              styles={styles}
              testID="liquidity-refresh-quote"
            />
          ) : null}
        </ScrollView>
      )}

      <Modal
        animationType="slide"
        onRequestClose={() => setAssetPicker(null)}
        transparent
        visible={assetPicker !== null}
      >
        <View style={styles.modalRoot}>
          <Pressable onPress={() => setAssetPicker(null)} style={styles.scrim} />
          <View style={styles.modalSheet}>
            <Text style={styles.heading}>Choose an asset</Text>
            <ScrollView>
              {tokens.map((token) => (
                <Pressable
                  key={swapAssetKey(token)}
                  onPress={() => chooseAsset(token)}
                  style={styles.tokenOption}
                  testID={`liquidity-token-${token.code}`}
                >
                  <Text style={styles.body}>{token.label}</Text>
                  <Text style={styles.muted}>{swapAssetLabel(token, networkName)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Divider({ styles }: { styles: ReturnType<typeof createStyles> }) {
  return <View style={styles.divider} />;
}

function InfoCard({
  styles,
  message,
  error = false,
  testID,
}: {
  styles: ReturnType<typeof createStyles>;
  message: string;
  error?: boolean;
  testID?: string;
}) {
  return (
    <View style={[styles.info, error && styles.errorInfo]} testID={testID}>
      <Text style={[styles.infoText, error && styles.errorText]}>{message}</Text>
    </View>
  );
}

function AssetChoice({
  label,
  detail,
  styles,
  onPress,
  testID,
}: {
  label: string;
  detail: string;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable onPress={onPress} style={styles.assetChoice} testID={testID}>
      <Text style={styles.assetChoiceLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.assetChoiceDetail}>{detail}</Text>
    </Pressable>
  );
}

function ActionButton({
  label,
  onPress,
  disabled = false,
  styles,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  styles?: ReturnType<typeof createStyles>;
  testID?: string;
}) {
  const { colors } = useTheme();
  const localStyles = useMemo(() => (styles ? null : createStyles(colors)), [colors, styles]);
  const applied = styles ?? localStyles!;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[applied.actionButton, disabled && applied.actionDisabled]}
      testID={testID}
    >
      <Text style={applied.actionText}>{label}</Text>
    </Pressable>
  );
}

function SlippageInput({
  colors,
  error,
  input,
  onChange,
  styles,
  warning,
}: {
  colors: ThemeColors;
  error: string | null;
  input: string;
  onChange: (value: string) => void;
  styles: ReturnType<typeof createStyles>;
  warning: boolean;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.sectionLabel}>SLIPPAGE TOLERANCE</Text>
      <TextInput
        accessibilityLabel="Slippage tolerance percentage"
        keyboardType="decimal-pad"
        onChangeText={onChange}
        placeholder="0.50"
        placeholderTextColor={colors.textFaint}
        style={styles.input}
        testID="liquidity-slippage"
        value={input}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {warning ? <Text style={styles.warningText}>High slippage tolerance can accept a worse price.</Text> : null}
      <Text style={styles.muted}>Default is 0.50%; allowed range is 0.10% to 5.00%.</Text>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 36, gap: 14 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 },
    subtitle: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20 },
    card: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      padding: 16,
      gap: 12,
    },
    modeTabs: {
      flexDirection: 'row',
      backgroundColor: colors.surfaceMd,
      borderRadius: 100,
      padding: 4,
    },
    modeTab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 100 },
    modeTabActive: { backgroundColor: colors.accent },
    modeTabText: { color: colors.textSecondary, fontFamily: fontFamily.bodyMedium, fontSize: 14 },
    modeTabTextActive: { color: colors.onAccent },
    sectionLabel: {
      color: colors.label,
      fontFamily: fontFamily.accent,
      fontSize: 12,
      letterSpacing: 0.8,
    },
    pairRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    pairSlash: { color: colors.textMuted, fontSize: 18 },
    assetChoice: {
      flex: 1,
      minHeight: 58,
      justifyContent: 'center',
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      backgroundColor: colors.surfaceMd,
      paddingHorizontal: 12,
      gap: 3,
    },
    assetChoiceLabel: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 15 },
    assetChoiceDetail: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 10 },
    input: {
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 12,
      backgroundColor: colors.surfaceMd,
      color: colors.textPrimary,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontFamily: fontFamily.body,
      fontSize: 17,
    },
    derived: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    impactCopy: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    muted: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 12, lineHeight: 18 },
    body: { color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 14, lineHeight: 20 },
    heading: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 20 },
    info: {
      padding: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceMd,
    },
    errorInfo: { borderColor: colors.danger, backgroundColor: colors.dangerSurface },
    infoText: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    errorText: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    warningText: { color: colors.accentText, fontFamily: fontFamily.body, fontSize: 13, lineHeight: 19 },
    actionButton: {
      minHeight: 52,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 100,
      backgroundColor: colors.accent,
      paddingHorizontal: 20,
    },
    actionDisabled: { opacity: 0.45 },
    actionText: { color: colors.onAccent, fontFamily: fontFamily.bodyMedium, fontSize: 15 },
    positionChoice: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surfaceMd,
      padding: 12,
      gap: 4,
    },
    positionChoiceActive: { borderColor: colors.accent },
    quickRow: { flexDirection: 'row', gap: 8 },
    quickButton: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10, backgroundColor: colors.surfaceMd },
    quickText: { color: colors.textPrimary, fontFamily: fontFamily.bodyMedium, fontSize: 12 },
    reviewAmount: { color: colors.textStrong, fontFamily: fontFamily.bodyMedium, fontSize: 17 },
    divider: { height: 1, backgroundColor: colors.border, marginVertical: 2 },
    successCard: { alignItems: 'center', gap: 14, paddingVertical: 24 },
    hash: { color: colors.textMuted, fontFamily: fontFamily.body, fontSize: 11 },
    modalRoot: { flex: 1, justifyContent: 'flex-end' },
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },
    modalSheet: {
      maxHeight: '75%',
      backgroundColor: colors.surfaceRaised,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 20,
      gap: 12,
    },
    tokenOption: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 4 },
  });
