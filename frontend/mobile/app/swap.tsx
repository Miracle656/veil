import { errorMessage } from '../lib/errorMessage';
import { Keypair } from '@stellar/stellar-sdk';
import { useLocalSearchParams } from 'expo-router';
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
import { enhanceQuoteWithSpread, type HonestSwapQuote } from '../lib/soroswapEnhanced';
import { PreConfirmationPanel } from '../components/PreConfirmationPanel';
import { getSoroswapQuote, buildSoroswapSwapXdr, ensureSwapOutTrustline, type SwapQuote } from '../lib/soroswap';
import { getSdexQuote, sdexSwap } from '../lib/sdexSwap';
import {
  noRouteMessage,
  swapAssetKey,
  swapAssetLabel,
  swapDestinations,
  swapRouteInput,
  type NetworkName,
  type SwapAsset,
} from '../lib/swapAssets';
import { getRegisteredAsset } from '../lib/assets';
import { fetchContractAssetBalance, getFeePayerAddress } from '../lib/activity';
import { getFeePayerXlm, sendAssetFromContract, type FeePayerXlm } from '../lib/contractSpend';
import { deployWalletIfNeeded } from '../lib/deployWallet';
import { useWallet } from '../components/WalletProvider';
import { getNetwork } from '../lib/network';
import { signAndSubmitSorobanXdr } from '../lib/sorobanTx';
import { useNetwork } from '../hooks/useNetwork';
import { requirePasskey } from '../lib/passkey';
import { getWalletAddress, getSignerSecret } from '../lib/walletStore';
import { loadHoldings, type Holding } from '../lib/holdings';

type Token = { code: string; name: string };
type Step = 'form' | 'review' | 'signing' | 'submitting' | 'done' | 'error';

const TOKENS: Token[] = [
  { code: 'XLM', name: 'Stellar Lumens' },
  { code: 'USDC', name: 'USD Coin' },
  { code: 'USDY', name: 'USD Yield' },
  { code: 'EURC', name: 'Euro Coin' },
  { code: 'AQUA', name: 'Aquarius' },
];
/** A swappable asset: a registry-checked code:issuer (issuer null = XLM). */
type Token = SwapAsset & { name: string };
type Step = 'form' | 'signing' | 'submitting' | 'done' | 'error';

/**
 * The tokens on offer, built from the verified registry for the network — XLM
 * plus each registered asset live there, issuer included (#793). The list used
 * to be bare codes (XLM, USDC, EURC, AQUA) resolved to contracts by symbol from
 * Soroswap's token list; EURC and AQUA are not in the registry, so they cannot
 * be addressed by issuer and are no longer offered.
 */
function tokensFor(network: NetworkName): Token[] {
  return swapDestinations(network).map((a) => ({
    ...a,
    name: a.issuer ? (getRegisteredAsset(a.code)?.name ?? a.code) : 'Stellar Lumens',
  }));
}

const SLIPPAGE_BPS = 50; // 0.5 %
const DEBOUNCE_MS = 600;
const PRICE_IMPACT_THRESHOLD_PCT = 5.0; // Refuse orders exceeding 5% total impact

export default function SwapScreen() {
  const { colors, isDark } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Soroswap is mainnet-only; on testnet we route through the classic DEX.
  // Subscribed: this flag picks the venue — SDEX on testnet, Soroswap on
  // mainnet — so reading it once at render risks routing a swap at the wrong
  // chain's liquidity if the network changes while this screen is alive.
  const { networkName } = useNetwork();
  const onTestnet = networkName === 'testnet';
  const TOKENS = useMemo(() => tokensFor(networkName), [networkName]);

  // A swap handed over by the agent: /swap?from=XLM&to=USDC&amount=10. Only
  // codes this screen lists and a plain positive amount are taken; anything else
  // leaves the ordinary defaults, so a bad link opens an ordinary form.
  const prefill = useLocalSearchParams<{ from?: string; to?: string; amount?: string }>();
  // A code from the agent resolves to the one registered asset with that code.
  const prefillToken = (code: string | string[] | undefined): Token | undefined =>
    typeof code === 'string' ? TOKENS.find((t) => t.code === code.toUpperCase()) : undefined;
  const prefillIn = prefillToken(prefill.from);
  const prefillOut = prefillToken(prefill.to);
  const samePair = !!prefillIn && !!prefillOut && swapAssetKey(prefillIn) === swapAssetKey(prefillOut);
  const [tokenIn, setTokenIn] = useState<Token>(prefillIn ?? TOKENS[0]!);
  const [tokenOut, setTokenOut] = useState<Token>(
    (!samePair && prefillOut) ||
      (prefillIn && swapAssetKey(prefillIn) === swapAssetKey(TOKENS[1]!) ? TOKENS[0]! : TOKENS[1]!),
  );
  const [amountIn, setAmountIn] = useState(
    typeof prefill.amount === 'string' && /^\d+(\.\d{1,7})?$/.test(prefill.amount) && Number(prefill.amount) > 0
      ? prefill.amount
      : '',
  );
  // A network switch changes which assets exist: USDT0 is mainnet-only, and
  // USDC has a different issuer on each chain. Start over from that network's
  // list rather than carry an asset the new network does not have.
  const pairNetwork = useRef(networkName);
  useEffect(() => {
    if (pairNetwork.current === networkName) return;
    pairNetwork.current = networkName;
    setTokenIn(TOKENS[0]!);
    setTokenOut(TOKENS[1]!);
    setQuote(null);
  }, [networkName, TOKENS]);
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

  // What the account that pays for swaps can actually spend. The holdings above
  // sum the smart wallet and the spending account, but a swap only ever touches
  // the latter — and most of what it holds can be locked as network reserve.
  const [feePayerXlm, setFeePayerXlm] = useState<FeePayerXlm | null>(null);
  // XLM held by the smart wallet itself. A swap cannot spend it directly, but it
  // can move it to the spending account first — see handleExecute. Without this
  // a wallet holding 31 XLM offered 1.4 to swap, because 27 of them sat in the
  // contract where the swap path never looked. `null` means not read yet.
  const [contractXlm, setContractXlm] = useState<number | null>(null);
  const { wallet } = useWallet();
  useEffect(() => {
    let alive = true;
    (async () => {
      const addr = await getWalletAddress().catch(() => null);
      if (!addr?.startsWith('C')) {
        if (alive) setContractXlm(0);
        return;
      }
      const held = await fetchContractAssetBalance(addr).catch(() => null);
      if (alive) setContractXlm(held);
    })();
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    let alive = true;
    getFeePayerXlm()
      .then((v) => { if (alive) setFeePayerXlm(v); })
      .catch(() => { if (alive) setFeePayerXlm(null); });
    return () => { alive = false; };
  }, []);

  // By code AND issuer: a held impostor sharing a code is not a balance of it.
  const balanceOf = (token: SwapAsset): number | null => {
    const h = holdings.find(
      (x) => swapAssetKey({ code: x.code, issuer: x.issuer }) === swapAssetKey(token),
    );
    return h ? Number(h.balance) : null;
  };
  const fmtBal = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [honestQuote, setHonestQuote] = useState<HonestSwapQuote | null>(null);
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

        // One pair, addressed by what it is: the SACs derived from each
        // code:issuer for Soroswap, the classic assets for the DEX (#793).
        const route = swapRouteInput(tokenIn, tokenOut, networkName, getNetwork().networkPassphrase);
        if (!route.ok) {
          setQuoteError(route.reason);
          setQuote(null);
          return;
        }

        if (onTestnet) {
          const sdex = await getSdexQuote(tokenIn, parsed.toString(), tokenOut);
          if (!sdex) {
            setQuoteError(noRouteMessage(tokenIn, tokenOut, networkName));
            setQuote(null);
            return;
          }
          setQuote({
            amountOut: Math.round(Number(sdex.amountOut) * 1e7).toString(),
            priceImpact: 0,
            path: sdex.path.map((a) => (a.isNative() ? 'native' : `${a.getCode()}:${a.getIssuer()}`)),
            protocols: ['SDEX'],
            rawQuote: null,
            ttl: Date.now() + 30_000,
          });
          return;
        }

        // The swap moves funds on the SPENDING (fee-payer G) account — its
        // source-account signature authorizes the token transfers. A smart
        // wallet's C-address can't be the transaction source at all.
        const feePayer = await getFeePayerAddress();
        if (!feePayer) {
          setQuoteError('No spending account on this device yet.');
          setQuote(null);
          return;
        }
        const result = await getSoroswapQuote({
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          amountIn: Math.round(parsed * 1e7).toString(),
          slippageBps: SLIPPAGE_BPS,
          feePayerAddress: feePayer,
        });
        if (result.ok) {
          setQuote(result.quote);
        } else {
          setQuote(null);
          // No route stays no route: nothing here substitutes another asset.
          setQuoteError(
            result.kind === 'no-route' ? noRouteMessage(tokenIn, tokenOut, networkName) : result.reason,
          );
        }
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
  }, [amountIn, tokenIn, tokenOut, networkName, onTestnet]);

  // ── Enhance quotes with spread and price impact data ──────────────────────
  useEffect(() => {
    if (!quote || onTestnet) {
      setHonestQuote(null);
      return;
    }

    let alive = true;
    (async () => {
      try {
        const parsed = parseFloat(amountIn);
        const enhanced = await enhanceQuoteWithSpread(
          quote,
          tokenIn.code,
          tokenOut.code,
          parsed,
          PRICE_IMPACT_THRESHOLD_PCT,
        );
        if (alive) setHonestQuote(enhanced);
      } catch (err) {
        console.warn('[swap] Failed to enhance quote with spread:', err);
        if (alive) setHonestQuote(quote as HonestSwapQuote);
      }
    })();
    return () => { alive = false; };
  }, [quote, tokenIn.code, tokenOut.code, amountIn, onTestnet]);

  /**
   * Make sure the spending account can cover an XLM swap, moving the shortfall
   * out of the smart wallet when it cannot.
   *
   * Needed = the amount, plus 0.5 XLM reserve if this swap opens a trustline for
   * the token being bought, plus a little for fees. Only the shortfall moves,
   * rounded up to the stroop so the account is never left a fraction short.
   * Does nothing when the spending account already has enough, or when the
   * smart wallet cannot cover the gap — the checks below then explain why.
   */
  async function topUpSpendingFromSmartWallet(amount: number, signerSecret: string) {
    const walletAddr = await getWalletAddress().catch(() => null);
    if (!walletAddr?.startsWith('C')) return;

    const opensTrustline = !!tokenOut.issuer && balanceOf(tokenOut) === null;
    const needed = amount + (opensTrustline ? 0.5 : 0) + 0.05;
    const before = await getFeePayerXlm();
    const shortfall = needed - before.spendable;
    if (shortfall <= 0) return;

    const inContract = await fetchContractAssetBalance(walletAddr);
    if (inContract < shortfall) return;

    // `__check_auth` cannot run against an undeployed contract; deploy first,
    // with the public key the address was derived from.
    await deployWalletIfNeeded(wallet.deploy, walletAddr);

    const move = (Math.ceil(shortfall * 1e7) / 1e7).toFixed(7);
    setStep('signing');
    await sendAssetFromContract(walletAddr, Keypair.fromSecret(signerSecret).publicKey(), move);
    setStep('submitting');

    // The transfer is confirmed on Soroban, but Horizon — which the checks
    // below read — can lag a few seconds behind. Wait for it rather than
    // failing the swap on a balance that has already arrived.
    for (let i = 0; i < 10; i++) {
      if ((await getFeePayerXlm()).spendable >= needed) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const moved = await getFeePayerXlm();
    setFeePayerXlm(moved);
    setContractXlm(Math.max(0, inContract - Number(move)));
  }

  // ── Execution — with honest threshold check ───────────────────────────────
  async function handleExecute() {
    setExecError(null);
    
    // Check if order exceeds price impact threshold
    if (honestQuote?.shouldRefuse && honestQuote?.refusalReason) {
      setExecError(honestQuote.refusalReason);
      setStep('error');
      return;
    }

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

      // Swaps run from the spending account. When paying in XLM and that
      // account is short, move the difference from the smart wallet first,
      // using the same passkey-authorised contract transfer as a send. This is
      // what lets a wallet whose XLM mostly sits in the contract swap at all.
      if (!tokenIn.issuer) {
        await topUpSpendingFromSmartWallet(parsed, signerSecret);
      }

      // Re-checked at submit rather than trusted from when it was quoted.
      const route = swapRouteInput(tokenIn, tokenOut, networkName, getNetwork().networkPassphrase);
      if (!route.ok) throw new Error(route.reason);

      // Testnet → classic DEX path payment (adds the destination trustline
      // when missing). Mainnet → Soroswap.
      if (onTestnet) {
        const hash = await sdexSwap({
          signerSecret,
          from: tokenIn,
          amountIn: parsed.toString(),
          to: tokenOut,
          slippageBps: SLIPPAGE_BPS,
        });
        setTxHash(hash);
        setStep('done');
        return;
      }

      // Everything from here runs on the fee-payer G-account, which is NOT the
      // account whose balance this screen shows — the screen sums the smart
      // wallet and the spending account, and swaps only ever touch the latter.
      // So a wallet showing 3 XLM can hold 2 of them somewhere this code path
      // cannot reach, and the first sign of it was Horizon rejecting the
      // trustline with tx_insufficient_balance.
      //
      // Stellar locks 1 XLM per account plus 0.5 per trustline, and the balance
      // may not fall below that, so a freshly funded 1 XLM fee-payer has
      // nothing spendable at all.
      const spendable = (await getFeePayerXlm()).spendable;
      const TRUSTLINE_RESERVE_XLM = 0.5;
      const needsTrustline = !!tokenOut.issuer && balanceOf(tokenOut) === null;

      if (needsTrustline && spendable < TRUSTLINE_RESERVE_XLM) {
        throw new Error(
          `Holding ${tokenOut.code} for the first time locks 0.5 XLM of network reserve, and the account that pays for swaps has ${fmtBal(spendable)} XLM spare. It is funded separately from your wallet balance — send it a little XLM and try again.`,
        );
      }

      // The router refuses to pay out to an account without the destination
      // trustline — open it first when missing (locks 0.5 XLM base reserve).
      await ensureSwapOutTrustline(signerSecret, tokenOut);

      // Paying in XLM comes out of that same account, so measure it against
      // what is spendable there rather than the balance on screen.
      if (!tokenIn.issuer) {
        const left = needsTrustline ? spendable - TRUSTLINE_RESERVE_XLM : spendable;
        if (parsed > left) {
          throw new Error(
            `The account that pays for swaps has ${fmtBal(Math.max(0, left))} XLM available and you asked to swap ${fmtBal(parsed)}. It is funded separately from your wallet balance.`,
          );
        }
      }

      // Check the balance before asking the router to build anything. An
      // account with nothing in it is the most common reason a build fails,
      // and the router's own error does not say so — it just refuses. Telling
      // the user here means they learn what is wrong instead of watching a
      // spinner end in a generic failure.
      const available = balanceOf(tokenIn);
      if (available !== null && available <= 0) {
        throw new Error(
          `You have no ${tokenIn.code} to swap. Receive or buy some first, then try again.`,
        );
      }
      if (available !== null && parsed > available) {
        throw new Error(
          `Not enough ${tokenIn.code}. You have ${fmtBal(available)} and tried to swap ${fmtBal(parsed)}.`,
        );
      }

      // Build against the spending account — the same key that signs below.
      const feePayer = Keypair.fromSecret(signerSecret).publicKey();
      // Build from a quote for exactly this pair: the one on screen while it
      // is fresh, otherwise a new one for the same two contracts, checked the
      // same way. If there is none, stop; do not route something else.
      let live = quote?.rawQuote && Date.now() <= quote.ttl ? quote.rawQuote : null;
      if (!live) {
        const fresh = await getSoroswapQuote({
          tokenIn: route.tokenIn,
          tokenOut: route.tokenOut,
          amountIn: Math.round(parsed * 1e7).toString(),
          slippageBps: SLIPPAGE_BPS,
          feePayerAddress: feePayer,
        });
        if (!fresh.ok) throw new Error(`The quote expired and could not be refreshed: ${fresh.reason}`);
        live = fresh.quote.rawQuote;
      }
      if (!live) throw new Error('No quote to build this swap from. Please retry.');
      const unsignedXdr = await buildSoroswapSwapXdr(live, feePayer);

      const network = getNetwork();
      // Testnet keypair mode: simulate → assemble → sign with the wallet key →
      // submit → poll to completion (source-account auth covers the swap).
      const hash = await signAndSubmitSorobanXdr({
        xdr: unsignedXdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        // The router can route through the classic order book, which submits
        // to Horizon rather than the Soroban RPC.
        horizonUrl: network.horizonUrl,
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
      if (swapAssetKey(token) === swapAssetKey(tokenOut)) setTokenOut(tokenIn);
      setTokenIn(token);
    } else if (picker === 'out') {
      if (swapAssetKey(token) === swapAssetKey(tokenIn)) setTokenIn(tokenOut);
      setTokenOut(token);
    }
    setPicker(null);
    setQuote(null);
    setHonestQuote(null);
    setQuoteError(null);
  }

  function flip() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setQuote(null);
    setHonestQuote(null);
    setQuoteError(null);
  }

  const hasAmount = Number(amountIn) > 0;
  const canReview = hasAmount && !!quote && !isFetchingQuote;
  const amountOutDisplay = quote
    ? String((Number(quote.amountOut) / 1e7).toFixed(7)).replace(/\.?0+$/, '')
    : '0.00';
  const rate =
    quote && Number(amountIn) > 0 ? (Number(quote.amountOut) / 1e7 / Number(amountIn)).toFixed(4) : null;

  // Paying in XLM comes out of the fee payer, so that is the number that
  // governs — not the wallet total. A hardcoded reserve guess used to stand in
  // for this and was wrong whenever the account held anything extra: every
  // trustline and data entry locks a further 0.5, and the recovery breadcrumbs
  // alone are three entries.
  const isXlmIn = !tokenIn.issuer;
  // Paying in XLM can draw on the smart wallet too: anything the spending
  // account is short of is moved across before the swap runs.
  const payableIn = isXlmIn
    ? feePayerXlm
      ? feePayerXlm.spendable + (contractXlm ?? 0)
      : null
    : balanceOf(tokenIn);
  // Measured against the fee payer's OWN balance. Comparing it to the wallet
  // total — which sums the smart wallet as well — reported more locked than the
  // account even holds.
  const lockedXlm = feePayerXlm ? Math.max(0, feePayerXlm.balance - feePayerXlm.spendable) : null;

  // ── Review screen with honest spread and impact ─────────────────────────────
  if (step === 'review' && honestQuote && quote) {
    const amountOut = Number(quote.amountOut) / 1e7;
    const currentRate = amountOut / Number(amountIn);
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']} testID="swap-review-screen">
        <View style={styles.body}>
          <FlowHeader 
            title="Review Swap" 
            onBack={() => { setStep('form'); }} 
          />
          
          <View style={styles.reviewContent}>
            <PreConfirmationPanel
              data={{
                tokenIn: tokenIn.code,
                tokenOut: tokenOut.code,
                amountIn: Number(amountIn),
                amountOut,
                rate: currentRate,
                priceImpactPct: (honestQuote.impactAnalysis?.priceImpactPct ?? 0),
                spreadPct: (honestQuote.impactAnalysis?.spreadPct ?? 0),
                totalImpactPct: (honestQuote.impactAnalysis?.totalImpactPct ?? 0),
                bestBid: honestQuote.spread?.bestBid,
                bestAsk: honestQuote.spread?.bestAsk,
                sellbackAmount: honestQuote.reverseQuote?.sellbackAmount,
                spreadLossPct: honestQuote.reverseQuote?.spreadLossPct,
                roundTripImpactPct: honestQuote.reverseQuote?.roundTripImpactPct,
              }}
              colors={colors}
            />
          </View>

          <View style={styles.spacer} />

          {honestQuote.shouldRefuse ? (
            <View>
              <Text style={styles.refusalBanner}>{honestQuote.refusalReason}</Text>
              <Pressable
                style={[styles.primaryBtn, styles.disabled]}
                onPress={() => setStep('form')}
              >
                <Text style={styles.primaryText}>Back to form</Text>
              </Pressable>
            </View>
          ) : (
            <SlideToConfirm label="Slide to confirm swap" onConfirm={handleExecute} />
          )}
        </View>
      </SafeAreaView>
    );
  }

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
              {payableIn !== null && (
                <Pressable
                  hitSlop={6}
                  onPress={() => setAmountIn(payableIn.toFixed(payableIn >= 1 ? 2 : 4))}
                >
                  <Text style={styles.legBalance}>Balance {fmtBal(payableIn)} · Max</Text>
                </Pressable>
              )}
            </View>
            {lockedXlm !== null && lockedXlm > 0.01 && isXlmIn && (
              <Text style={styles.legHint}>
                {fmtBal(lockedXlm)} of the spending account&rsquo;s {fmtBal(feePayerXlm?.balance ?? 0)} XLM
                is held as network reserve ({feePayerXlm?.subentries ?? 0}{' '}
                {feePayerXlm?.subentries === 1 ? 'subentry' : 'subentries'}). It is refundable, not spent.
              </Text>
            )}
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
              {balanceOf(tokenOut) !== null && (
                <Text style={styles.legBalance}>Balance {fmtBal(balanceOf(tokenOut)!)}</Text>
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
          {/* Which asset each side is, issuer included, so the user can see
              which USDT0 of eight they are trading (#793). */}
          <View style={styles.rateRow}>
            <Text style={styles.rateLabel}>Pay</Text>
            <Text style={styles.rateValue} testID="swap-pay-asset">{swapAssetLabel(tokenIn, networkName)}</Text>
          </View>
          <View style={styles.rateRow}>
            <Text style={styles.rateLabel}>Receive</Text>
            <Text style={styles.rateValue} testID="swap-receive-asset">{swapAssetLabel(tokenOut, networkName)}</Text>
          </View>
          {quote && (
            <View style={styles.rateRow}>
              <Text style={styles.rateLabel}>Route · slippage</Text>
              <Text style={styles.rateValue}>
                {quote.protocols.join(' · ') || 'SDEX'} · {SLIPPAGE_BPS / 100}%
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
          <Pressable
            style={styles.primaryBtn}
            onPress={() => setStep('review')}
          >
            <Text style={styles.primaryText}>Review swap</Text>
          </Pressable>
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
              <Pressable key={swapAssetKey(t)} style={styles.sheetRow} onPress={() => handleSelect(t)}>
                <TokenChip token={t} colors={colors} static />
                <Text style={styles.sheetName}>
                  {t.issuer ? `${t.name} · ${swapAssetLabel(t, networkName)}` : t.name}
                </Text>
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
    legHint: {
      color: colors.textMuted,
      fontFamily: fontFamily.body,
      fontSize: 11,
      marginTop: 6,
    },
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
    reviewContent: { flex: 1, marginTop: 12 },
    refusalBanner: {
      color: colors.danger,
      fontFamily: fontFamily.body,
      fontSize: 13,
      backgroundColor: colors.dangerSurface,
      borderRadius: 10,
      padding: 12,
      marginBottom: 16,
    },
  });
