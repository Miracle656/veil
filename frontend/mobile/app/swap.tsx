import { errorMessage } from '../lib/errorMessage';
import { Keypair } from '@stellar/stellar-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../lib/theme';
import { fontFamily } from '../theme/typography';
import { FlowHeader } from '../components/FlowHeader';
import { SlideToConfirm } from '../components/SlideToConfirm';
import { SwapVerticalIcon } from '../components/icons';
import { TokenIcon } from '../components/TokenIcon';
import { SuccessAnimation } from '../components/SuccessAnimation';
import { getSoroswapQuote, buildSoroswapSwapXdr, ensureSwapOutTrustline, resolveTokenAddress, type SwapQuote } from '../lib/soroswap';
import { getSdexQuote, sdexSwap, sdexSupported } from '../lib/sdexSwap';
import { getFeePayerAddress } from '../lib/activity';
import { getNetwork } from '../lib/network';
import { signAndSubmitSorobanXdr } from '../lib/sorobanTx';
import { requirePasskey } from '../lib/passkey';
import { getWalletAddress, getSignerSecret } from '../lib/walletStore';
import { loadHoldings, type Holding } from '../lib/holdings';

type Token = { code: string; name: string };
type Step = 'form' | 'signing' | 'submitting' | 'done' | 'error';

const TOKENS: Token[] = [
  { code: 'XLM', name: 'Stellar Lumens' },
  { code: 'USDC', name: 'USD Coin' },
  { code: 'EURC', name: 'Euro Coin' },
  { code: 'AQUA', name: 'Aquarius' },
];

const SLIPPAGE_BPS = 50; // 0.5 %
const DEBOUNCE_MS = 600;

export default function SwapScreen() {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Soroswap is mainnet-only; on testnet we route through the classic DEX.
  const onTestnet = getNetwork().name === 'testnet';

  const [tokenIn, setTokenIn] = useState<Token>(TOKENS[0]!);
  const [tokenOut, setTokenOut] = useState<Token>(TOKENS[1]!);
  const [amountIn, setAmountIn] = useState('');
  const [picker, setPicker] = useState<null | 'in' | 'out'>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const addr = await getWalletAddress().catch(() => null);
      if (!addr) return;
      const hs = await loadHoldings(addr).catch(() => [] as Holding[]);
      if (alive) setHoldings(hs);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const balanceOf = (code: string): number | null => {
    const h = holdings.find((x) => x.code.toUpperCase() === code.toUpperCase());
    return h ? Number(h.balance) : null;
  };
  const fmtBal = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [isFetchingQuote, setIsFetchingQuote] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>('form');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Quote fetching (debounced) — unchanged engine ──────────────────────────
  useEffect(() => {
    const parsed = parseFloat(amountIn);
    if (!amountIn || isNaN(parsed) || parsed <= 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setIsFetchingQuote(true);
      setQuoteError(null);
      try {
        const walletAddress = await getWalletAddress();
        if (!walletAddress) {
          setQuoteError('Wallet not set up yet.');
          setQuote(null);
          return;
        }

        if (onTestnet) {
          if (!sdexSupported(tokenIn.code) || !sdexSupported(tokenOut.code)) {
            const missing = !sdexSupported(tokenIn.code) ? tokenIn.code : tokenOut.code;
            setQuoteError(`${missing} isn't available for testnet swaps (XLM ↔ USDC).`);
            setQuote(null);
            return;
          }
          const sdex = await getSdexQuote(tokenIn.code, parsed.toString(), tokenOut.code);
          if (!sdex) {
            setQuoteError('No DEX path for this pair — no testnet liquidity bridges it.');
            setQuote(null);
            return;
          }
          setQuote({
            amountOut: Math.round(Number(sdex.amountOut) * 1e7).toString(),
            priceImpact: 0,
            path: sdex.path.map((a) => (a.isNative() ? 'native' : `${a.getCode()}:${a.getIssuer()}`)),
            protocols: ['SDEX'],
            rawQuote: sdex,
            ttl: Date.now() + 30_000,
          });
          return;
        }

        // The swap moves funds on the SPENDING (fee-payer G) account — its
        // source-account signature authorizes the token transfers. A smart
        // wallet's C-address can't be the transaction source at all.
        const [tokenInAddr, tokenOutAddr, feePayer] = await Promise.all([
          resolveTokenAddress(tokenIn.code),
          resolveTokenAddress(tokenOut.code),
          getFeePayerAddress(),
        ]);
        if (!tokenInAddr || !tokenOutAddr) {
          setQuoteError('Token not found in Soroswap list.');
          setQuote(null);
          return;
        }
        if (!feePayer) {
          setQuoteError('No spending account on this device yet.');
          setQuote(null);
          return;
        }
        const result = await getSoroswapQuote({
          tokenIn: tokenInAddr,
          tokenOut: tokenOutAddr,
          amountIn: Math.round(parsed * 1e7).toString(),
          slippageBps: SLIPPAGE_BPS,
          feePayerAddress: feePayer,
        });
        setQuote(result);
        if (!result) setQuoteError('No liquidity found for this pair.');
      } catch {
        setQuoteError('Quote failed. Check your connection.');
        setQuote(null);
      } finally {
        setIsFetchingQuote(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [amountIn, tokenIn.code, tokenOut.code, onTestnet]);

  // ── Execution — unchanged engine ───────────────────────────────────────────
  async function handleExecute() {
    setExecError(null);
    setStep('signing');
    try {
      const parsed = parseFloat(amountIn);
      // Presence gate: when a passkey is registered, spending demands it.
      await requirePasskey();
      const signerSecret = await getSignerSecret();
      if (!signerSecret) throw new Error('No wallet key on this device. Create a testnet wallet first.');
      // Passkey ceremony done — everything past here is network work, so stop
      // showing "Waiting for passkey…".
      setStep('submitting');

      // Testnet → classic DEX path payment (adds the destination trustline
      // when missing). Mainnet → Soroswap.
      if (onTestnet) {
        const hash = await sdexSwap({
          signerSecret,
          sourceCode: tokenIn.code,
          amountIn: parsed.toString(),
          destCode: tokenOut.code,
          slippageBps: SLIPPAGE_BPS,
        });
        setTxHash(hash);
        setStep('done');
        return;
      }

      const [tokenInAddr, tokenOutAddr] = await Promise.all([
        resolveTokenAddress(tokenIn.code),
        resolveTokenAddress(tokenOut.code),
      ]);
      if (!tokenInAddr || !tokenOutAddr) {
        const missing = !tokenInAddr ? tokenIn.code : tokenOut.code;
        throw new Error(`${missing} isn't listed on Soroswap for this network — swaps use Soroswap liquidity (mainnet).`);
      }
      // The router refuses to pay out to an account without the destination
      // trustline — open it first when missing (locks 0.5 XLM base reserve).
      await ensureSwapOutTrustline(signerSecret, tokenOut.code);

      // Build against the spending account — the same key that signs below.
      const feePayer = Keypair.fromSecret(signerSecret).publicKey();
      const unsignedXdr = await buildSoroswapSwapXdr({
        tokenIn: tokenInAddr,
        tokenOut: tokenOutAddr,
        amountIn: Math.round(parsed * 1e7).toString(),
        slippageBps: SLIPPAGE_BPS,
        feePayerAddress: feePayer,
      });
      if (!unsignedXdr) throw new Error('Failed to build swap transaction.');

      const network = getNetwork();
      // Testnet keypair mode: simulate → assemble → sign with the wallet key →
      // submit → poll to completion (source-account auth covers the swap).
      const hash = await signAndSubmitSorobanXdr({
        xdr: unsignedXdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
      });
      setTxHash(hash);
      setStep('done');
    } catch (err: unknown) {
      const msg = errorMessage(err);
      const name = err instanceof Error ? err.name : '';
      const friendly =
        name === 'NotFoundError' || /^not found$/i.test(msg.trim())
          ? onTestnet
            ? 'Your spending account has no XLM yet. Open Settings → Fund test XLM, then try again.'
            : 'Your spending account has no XLM yet. Deposit XLM to it first (Receive → Spending account).'
          : msg === 'USER_REJECTED'
            ? 'Signing was declined.'
            : msg;
      setExecError(friendly);
      setStep('error');
    }
  }

  function handleSelect(token: Token) {
    if (picker === 'in') {
      if (token.code === tokenOut.code) setTokenOut(tokenIn);
      setTokenIn(token);
    } else if (picker === 'out') {
      if (token.code === tokenIn.code) setTokenIn(tokenOut);
      setTokenOut(token);
    }
    setPicker(null);
    setQuote(null);
    setQuoteError(null);
  }

  function flip() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setQuote(null);
    setQuoteError(null);
  }

  const hasAmount = Number(amountIn) > 0;
  const canReview = hasAmount && !!quote && !isFetchingQuote;
  const amountOutDisplay = quote
    ? String((Number(quote.amountOut) / 1e7).toFixed(7)).replace(/\.?0+$/, '')
    : '0.00';
  const rate =
    quote && Number(amountIn) > 0 ? (Number(quote.amountOut) / 1e7 / Number(amountIn)).toFixed(4) : null;

  // ── Done / status ──────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="swap-screen">
        <View style={styles.body}>
          <FlowHeader title="Swap" onBack={() => { setStep('form'); setTxHash(null); }} />
          <View style={styles.doneWrap}>
            <SuccessAnimation
              title="Swap complete"
              subtitle={`${amountIn} ${tokenIn.code} → ${amountOutDisplay} ${tokenOut.code}`}
              FromIcon={SwapVerticalIcon}
            />
            {txHash ? <Text style={styles.resultHash}>tx {txHash.slice(0, 8)}…{txHash.slice(-6)}</Text> : null}
            <Pressable style={[styles.primaryBtn, styles.doneCta]} onPress={() => { setStep('form'); setAmountIn(''); setTxHash(null); }}>
              <Text style={styles.primaryText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const busy = step === 'signing' || step === 'submitting';

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="swap-screen">
      <View style={styles.body}>
        <FlowHeader title="Swap" />

        {/* Pay / receive cards with the direction toggle between them */}
        <View style={styles.pairWrap}>
          <View style={[styles.leg, styles.legTop]}>
            <View style={styles.legHead}>
              <Text style={styles.legLabel}>You pay</Text>
              {balanceOf(tokenIn.code) !== null && (
                <Pressable
                  hitSlop={6}
                  onPress={() => {
                    const b = balanceOf(tokenIn.code) ?? 0;
                    const usable = tokenIn.code.toUpperCase() === 'XLM' ? Math.max(0, b - 1.5) : b;
                    setAmountIn(usable.toFixed(usable >= 1 ? 2 : 4));
                  }}
                >
                  <Text style={styles.legBalance}>Balance {fmtBal(balanceOf(tokenIn.code)!)} · Max</Text>
                </Pressable>
              )}
            </View>
            <View style={styles.legRow}>
              <TextInput
                style={styles.legAmount}
                value={amountIn}
                onChangeText={setAmountIn}
                placeholder="0"
                placeholderTextColor={colors.textFaint}
                keyboardType="decimal-pad"
                editable={!busy}
                testID="swap-amount-in"
              />
              <TokenChip token={tokenIn} onPress={() => setPicker('in')} colors={colors} />
            </View>
          </View>

          <View style={[styles.leg, styles.legBottom]}>
            <View style={styles.legHead}>
              <Text style={styles.legLabel}>You receive</Text>
              {balanceOf(tokenOut.code) !== null && (
                <Text style={styles.legBalance}>Balance {fmtBal(balanceOf(tokenOut.code)!)}</Text>
              )}
            </View>
            <View style={styles.legRow}>
              <Text style={[styles.legAmount, styles.legAmountOut]} numberOfLines={1}>
                {isFetchingQuote ? '…' : amountOutDisplay}
              </Text>
              <TokenChip token={tokenOut} onPress={() => setPicker('out')} colors={colors} accent />
            </View>
          </View>

          <Pressable onPress={flip} accessibilityRole="button" accessibilityLabel="Swap direction" style={styles.flipFab}>
            <SwapVerticalIcon size={20} color={colors.onAccent} />
          </Pressable>
        </View>

        {/* Rate / status */}
        <View style={styles.ratePanel}>
          {quoteError ? (
            <Text style={styles.rateError}>{quoteError}</Text>
          ) : (
            <View style={styles.rateRow}>
              <Text style={styles.rateLabel}>Rate</Text>
              <Text style={styles.rateValue}>
                {rate ? `1 ${tokenIn.code} = ${rate} ${tokenOut.code}` : '—'}
              </Text>
            </View>
          )}
          <View style={styles.rateRow}>
            <Text style={styles.rateLabel}>Network fee</Text>
            <Text style={styles.rateSponsored}>Sponsored</Text>
          </View>
        </View>

        {execError ? <Text style={styles.errorBanner}>{execError}</Text> : null}

        <View style={styles.spacer} />

        {busy ? (
          <View style={styles.status}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.statusText}>{step === 'signing' ? 'Waiting for passkey…' : 'Submitting swap…'}</Text>
          </View>
        ) : canReview ? (
          <SlideToConfirm label="Slide to swap" onConfirm={handleExecute} />
        ) : (
          <View style={[styles.primaryBtn, styles.disabled]}>
            <Text style={styles.primaryText}>{hasAmount ? 'Fetching quote…' : 'Enter an amount'}</Text>
          </View>
        )}
      </View>

      {/* Token picker */}
      <Modal visible={picker !== null} transparent animationType="fade" onRequestClose={() => setPicker(null)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setPicker(null)}>
          <Pressable style={[styles.sheet, { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF' }]} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Select token</Text>
            {TOKENS.map((t) => (
              <Pressable key={t.code} style={styles.sheetRow} onPress={() => handleSelect(t)}>
                <TokenChip token={t} colors={colors} static />
                <Text style={styles.sheetName}>{t.name}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

/** Small pill showing a token badge + code (+ chevron unless static). */
function TokenChip({
  token,
  onPress,
  colors,
  accent = false,
  static: isStatic = false,
}: {
  token: Token;
  onPress?: () => void;
  colors: ThemeColors;
  accent?: boolean;
  static?: boolean;
}) {
  const s = chipStyles(colors, accent);
  const content = (
    <View style={s.chip}>
      <TokenIcon code={token.code} size={26} />
      <Text style={s.code}>{token.code}</Text>
      {!isStatic && <Text style={s.chev}>▾</Text>}
    </View>
  );
  if (isStatic || !onPress) return content;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Select ${token.code}`}>
      {content}
    </Pressable>
  );
}

const chipStyles = (colors: ThemeColors, accent: boolean) =>
  StyleSheet.create({
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: accent ? colors.positiveSurface : colors.surfaceMd,
      borderWidth: 1,
      borderColor: accent ? 'rgba(0,167,181,0.3)' : colors.border,
      borderRadius: 999,
      paddingLeft: 6,
      paddingRight: 12,
      paddingVertical: 6,
    },
    code: { color: colors.textPrimary, fontFamily: fontFamily.bodySemiBold, fontSize: 14 },
    chev: { color: colors.textFaint, fontSize: 11 },
  });

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.background },
    body: { flex: 1, paddingHorizontal: 28, paddingTop: 20, paddingBottom: 32, gap: 20 },
    pairWrap: { position: 'relative', marginTop: 6 },
    leg: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: 18 },
    legTop: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderBottomLeftRadius: 6, borderBottomRightRadius: 6, marginBottom: 4 },
    legBottom: { borderTopLeftRadius: 6, borderTopRightRadius: 6, borderBottomLeftRadius: 20, borderBottomRightRadius: 20 },
    legHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    legLabel: {
      color: colors.textFaint,
      fontFamily: fontFamily.bodySemiBold,
      fontSize: 11,
      letterSpacing: 1.2,
      textTransform: 'uppercase',
    },
    legBalance: { color: colors.accent, fontFamily: fontFamily.bodyMedium, fontSize: 11.5 },
    doneWrap: { alignItems: 'center', marginTop: 52, gap: 20 },
    doneCta: { alignSelf: 'stretch', marginTop: 16 },
    legRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, gap: 12 },
    legAmount: {
      flex: 1,
      color: colors.textStrong,
      fontFamily: fontFamily.heading,
      fontSize: 36,
      paddingVertical: 2,
    },
    legAmountOut: { color: colors.positive },
    flipFab: {
      position: 'absolute',
      left: '50%',
      top: '50%',
      marginLeft: -22,
      marginTop: -22,
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 5,
      borderColor: colors.background,
    },
    ratePanel: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 20,
      paddingHorizontal: 18,
      paddingVertical: 6,
    },
    rateRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
    rateLabel: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 12 },
    rateValue: { color: colors.textPrimary, fontFamily: fontFamily.address, fontSize: 12 },
    rateSponsored: { color: colors.positive, fontFamily: fontFamily.bodyMedium, fontSize: 12 },
    rateError: { color: colors.danger, fontFamily: fontFamily.body, fontSize: 13, paddingVertical: 12 },
    errorBanner: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13,
      backgroundColor: colors.dangerSurface,
      borderRadius: 10,
      padding: 12,
    },
    status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 18 },
    statusText: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 14 },
    spacer: { flex: 1 },
    primaryBtn: { backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 16, alignItems: 'center' },
    disabled: { opacity: 0.4 },
    primaryText: { color: colors.onAccent, fontFamily: fontFamily.bodySemiBold, fontSize: 15 },
    resultCard: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 20, padding: 20, gap: 8, marginTop: 20 },
    resultTitle: { color: colors.textStrong, fontFamily: fontFamily.heading, fontSize: 24 },
    resultSub: { color: colors.textSecondary, fontFamily: fontFamily.body, fontSize: 15, marginTop: 4 },
    resultHash: { color: colors.textFaint, fontFamily: fontFamily.address, fontSize: 12, marginTop: 6 },
    sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: colors.surfaceMd, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, paddingBottom: 40, gap: 4 },
    sheetTitle: { color: colors.textFaint, fontFamily: fontFamily.bodySemiBold, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8 },
    sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
    sheetName: { color: colors.textPrimary, fontFamily: fontFamily.body, fontSize: 15 },
  });
