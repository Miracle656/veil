import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { rpc as SorobanRpc, TransactionBuilder } from "@stellar/stellar-sdk";
import { useRouter } from "expo-router";

import { Button, Card, Screen } from "../components/ui";
import { registerPasskeySigner } from "../lib/passkey";
import { getSoroswapQuote, buildSoroswapSwapXdr, resolveTokenAddress, type SwapQuote } from "../lib/soroswap";
import { getNetwork } from "../lib/network";
import { signXdrPayload } from "../lib/walletConnect";
import { getWalletAddress } from "../lib/walletStore";
import { colors } from "../theme/colors";
import { fontFamily, typography } from "../theme/typography";

// ── Types ─────────────────────────────────────────────────────────────────────

type Token = { code: string; name: string };
type Step = "form" | "confirm" | "signing" | "submitting" | "done" | "error";

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKENS: Token[] = [
  { code: "XLM", name: "Stellar Lumens" },
  { code: "USDC", name: "USD Coin" },
  { code: "EURC", name: "Euro Coin" },
  { code: "AQUA", name: "Aquarius" },
];

const SLIPPAGE_BPS = 50; // 0.5 %
const DEBOUNCE_MS = 600;

// ── Screen ────────────────────────────────────────────────────────────────────

export default function SwapScreen() {
  const router = useRouter();

  // Form
  const [tokenIn, setTokenIn] = useState<Token>(TOKENS[0]!);
  const [tokenOut, setTokenOut] = useState<Token>(TOKENS[1]!);
  const [amountIn, setAmountIn] = useState("");
  const [picker, setPicker] = useState<null | "in" | "out">(null);

  // Quote
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [isFetchingQuote, setIsFetchingQuote] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Execution
  const [step, setStep] = useState<Step>("form");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [execError, setExecError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Quote fetching ──────────────────────────────────────────────────────────

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
        const [tokenInAddr, tokenOutAddr, walletAddress] = await Promise.all([
          resolveTokenAddress(tokenIn.code),
          resolveTokenAddress(tokenOut.code),
          getWalletAddress(),
        ]);

        if (!tokenInAddr || !tokenOutAddr) {
          setQuoteError("Token not found in Soroswap list.");
          setQuote(null);
          return;
        }
        if (!walletAddress) {
          setQuoteError("Wallet not set up yet.");
          setQuote(null);
          return;
        }

        const result = await getSoroswapQuote({
          tokenIn: tokenInAddr,
          tokenOut: tokenOutAddr,
          amountIn: Math.round(parsed * 1e7).toString(),
          slippageBps: SLIPPAGE_BPS,
          feePayerAddress: walletAddress,
        });

        setQuote(result);
        if (!result) setQuoteError("No liquidity found for this pair.");
      } catch {
        setQuoteError("Quote failed. Check your connection.");
        setQuote(null);
      } finally {
        setIsFetchingQuote(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [amountIn, tokenIn.code, tokenOut.code]);

  // ── Execution ───────────────────────────────────────────────────────────────

  async function handleExecute() {
    setExecError(null);
    setStep("signing");

    // registerPasskeySigner makes the device passkey available to signXdrPayload
    // via the walletConnect auth-entry signer slot.
    const unregister = registerPasskeySigner();
    try {
      const parsed = parseFloat(amountIn);
      const [tokenInAddr, tokenOutAddr, walletAddress] = await Promise.all([
        resolveTokenAddress(tokenIn.code),
        resolveTokenAddress(tokenOut.code),
        getWalletAddress(),
      ]);

      if (!tokenInAddr || !tokenOutAddr || !walletAddress) {
        throw new Error("Missing token addresses or wallet not configured.");
      }

      const unsignedXdr = await buildSoroswapSwapXdr({
        tokenIn: tokenInAddr,
        tokenOut: tokenOutAddr,
        amountIn: Math.round(parsed * 1e7).toString(),
        slippageBps: SLIPPAGE_BPS,
        feePayerAddress: walletAddress,
      });

      if (!unsignedXdr) throw new Error("Failed to build swap transaction.");

      // Simulate → sign each Soroban auth entry with the passkey → assemble
      // with the fee-payer keypair. The biometric prompt fires inside here.
      const signedXdr = await signXdrPayload(unsignedXdr);

      setStep("submitting");
      const network = getNetwork();
      const rpc = new SorobanRpc.Server(network.rpcUrl);
      const signedTx = TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase);

      const sendResult = await rpc.sendTransaction(signedTx);
      if (sendResult.status === "ERROR") {
        throw new Error(
          `Network rejected the transaction: ${sendResult.errorResult?.toXDR("base64") ?? "unknown"}`
        );
      }

      for (let i = 0; i < 30; i++) {
        await new Promise<void>((r) => setTimeout(r, 1_000));
        const poll = await rpc.getTransaction(sendResult.hash);
        if (poll.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          if (poll.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
            throw new Error(`Transaction failed on-chain: ${poll.status}`);
          }
          setTxHash(sendResult.hash);
          setStep("done");
          return;
        }
      }
      throw new Error("Transaction timed out. Check your wallet history.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setExecError(msg === "USER_REJECTED" ? "Passkey authentication was declined." : msg);
      setStep("error");
    } finally {
      unregister();
    }
  }

  function reset() {
    setStep("form");
    setExecError(null);
    setTxHash(null);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function handleSelect(token: Token) {
    if (picker === "in") {
      if (token.code === tokenOut.code) setTokenOut(tokenIn);
      setTokenIn(token);
    } else if (picker === "out") {
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
    ? String((Number(quote.amountOut) / 1e7).toFixed(7)).replace(/\.?0+$/, "")
    : "0.00";

  // ── Confirm ─────────────────────────────────────────────────────────────────

  if (step === "confirm") {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={[typography.heading, styles.title]}>Confirm swap</Text>
          <Card style={styles.confirmCard}>
            <InfoRow label="You pay" value={`${amountIn} ${tokenIn.code}`} />
            <InfoRow label="You receive (est.)" value={`${amountOutDisplay} ${tokenOut.code}`} />
            {quote && (
              <>
                <InfoRow
                  label="Price impact"
                  value={
                    quote.priceImpact < 0.0001
                      ? "< 0.01%"
                      : `${(quote.priceImpact * 100).toFixed(2)}%`
                  }
                />
                <InfoRow label="Route" value={quote.protocols.join(" · ")} />
              </>
            )}
            <InfoRow label="Slippage tolerance" value="0.5%" />
          </Card>
          <Button label="Confirm swap" variant="gold" onPress={handleExecute} />
          <Button
            label="Edit"
            variant="ghost"
            onPress={() => setStep("form")}
            style={styles.secondaryBtn}
          />
        </ScrollView>
      </Screen>
    );
  }

  // ── Signing ──────────────────────────────────────────────────────────────────

  if (step === "signing") {
    return (
      <Screen>
        <View style={styles.statusWrap}>
          <ActivityIndicator color={colors.gold} size="large" style={styles.spinner} />
          <Text style={styles.statusTitle}>Awaiting passkey</Text>
          <Text style={styles.statusBody}>
            Approve with Face ID or fingerprint to authorize the swap
          </Text>
        </View>
      </Screen>
    );
  }

  // ── Submitting ───────────────────────────────────────────────────────────────

  if (step === "submitting") {
    return (
      <Screen>
        <View style={styles.statusWrap}>
          <ActivityIndicator color={colors.gold} size="large" style={styles.spinner} />
          <Text style={styles.statusTitle}>Broadcasting</Text>
          <Text style={styles.statusBody}>Submitting your swap to Stellar</Text>
        </View>
      </Screen>
    );
  }

  // ── Done ─────────────────────────────────────────────────────────────────────

  if (step === "done") {
    return (
      <Screen>
        <View style={styles.statusWrap}>
          <View style={styles.successCircle}>
            <Text style={styles.successIcon}>✓</Text>
          </View>
          <Text style={styles.statusTitle}>Swap complete</Text>
          <Text style={styles.statusBody}>
            {amountIn} {tokenIn.code} → {amountOutDisplay} {tokenOut.code}
          </Text>
          {txHash && (
            <Text style={styles.hash}>
              {txHash.slice(0, 12)}...{txHash.slice(-8)}
            </Text>
          )}
          <Button
            label="Done"
            variant="gold"
            onPress={() => router.back()}
            style={styles.secondaryBtn}
          />
        </View>
      </Screen>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────────

  if (step === "error") {
    return (
      <Screen>
        <View style={styles.statusWrap}>
          <View style={styles.errorCircle}>
            <Text style={styles.errorCircleIcon}>!</Text>
          </View>
          <Text style={styles.statusTitle}>Swap failed</Text>
          <Text style={styles.statusBody}>{execError}</Text>
          <Button
            label="Try again"
            variant="ghost"
            onPress={reset}
            style={styles.secondaryBtn}
          />
        </View>
      </Screen>
    );
  }

  // ── Form ──────────────────────────────────────────────────────────────────────

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[typography.heading, styles.title]}>Swap tokens</Text>

        {/* You pay */}
        <Card style={styles.leg}>
          <View style={styles.legHeader}>
            <Text style={styles.legLabel}>YOU PAY</Text>
            <Text style={styles.balance}>Balance —</Text>
          </View>
          <View style={styles.legRow}>
            <TokenButton token={tokenIn} onPress={() => setPicker("in")} />
            <TextInput
              style={styles.amountInput}
              value={amountIn}
              onChangeText={(val) => {
                setAmountIn(val);
                setQuote(null);
                setQuoteError(null);
              }}
              placeholder="0.00"
              placeholderTextColor="rgba(246,247,248,0.3)"
              keyboardType="decimal-pad"
              textAlign="right"
            />
          </View>
        </Card>

        {/* Flip direction */}
        <View style={styles.flipWrap}>
          <Pressable
            onPress={flip}
            accessibilityRole="button"
            accessibilityLabel="Swap direction"
            style={styles.flipButton}
          >
            <Text style={styles.flipIcon}>↓</Text>
          </Pressable>
        </View>

        {/* You receive */}
        <Card style={styles.leg}>
          <View style={styles.legHeader}>
            <Text style={styles.legLabel}>YOU RECEIVE</Text>
          </View>
          <View style={styles.legRow}>
            <TokenButton token={tokenOut} onPress={() => setPicker("out")} />
            {isFetchingQuote ? (
              <ActivityIndicator color={colors.gold} size="small" style={styles.quoteSpinner} />
            ) : (
              <Text style={[styles.amountInput, styles.amountOut]}>{amountOutDisplay}</Text>
            )}
          </View>
        </Card>

        {/* Quote area */}
        <Card variant="md" style={styles.quote}>
          {!hasAmount && (
            <>
              <Text style={styles.quoteTitle}>Enter an amount</Text>
              <Text style={styles.quoteBody}>
                Enter an amount above to see what you'll receive.
              </Text>
            </>
          )}
          {hasAmount && isFetchingQuote && (
            <Text style={styles.quoteBody}>Getting best price...</Text>
          )}
          {hasAmount && !isFetchingQuote && quoteError && (
            <Text style={[styles.quoteBody, styles.quoteErrorText]}>{quoteError}</Text>
          )}
          {hasAmount && !isFetchingQuote && quote && (
            <>
              <InfoRow
                label="Rate"
                value={`1 ${tokenIn.code} ≈ ${(Number(quote.amountOut) / (parseFloat(amountIn) * 1e7)).toFixed(6)} ${tokenOut.code}`}
              />
              <InfoRow
                label="Price impact"
                value={
                  quote.priceImpact < 0.0001
                    ? "< 0.01%"
                    : `${(quote.priceImpact * 100).toFixed(2)}%`
                }
              />
              <InfoRow label="Route" value={quote.protocols.join(" · ")} />
            </>
          )}
        </Card>

        <Button
          label="Review swap"
          variant="gold"
          disabled={!canReview}
          onPress={() => setStep("confirm")}
        />
      </ScrollView>

      {/* Token picker modal */}
      <Modal
        visible={picker !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPicker(null)}
      >
        <View style={styles.modalRoot}>
          <Pressable style={styles.backdrop} onPress={() => setPicker(null)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Select a token</Text>
            {TOKENS.map((t) => (
              <Pressable key={t.code} style={styles.tokenRow} onPress={() => handleSelect(t)}>
                <View style={styles.tokenDot} />
                <View style={styles.tokenRowText}>
                  <Text style={styles.tokenRowCode}>{t.code}</Text>
                  <Text style={styles.tokenRowName}>{t.name}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TokenButton({ token, onPress }: { token: Token; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Select token, currently ${token.code}`}
      style={styles.tokenButton}
    >
      <View style={styles.tokenDot} />
      <Text style={styles.tokenCode}>{token.code}</Text>
      <Text style={styles.chevron}>▾</Text>
    </Pressable>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  content: {
    gap: 12,
    paddingVertical: 24,
  },
  title: {
    color: colors.offWhite,
    marginBottom: 8,
  },
  leg: {
    padding: 20,
  },
  legHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  legLabel: {
    fontFamily: fontFamily.accent,
    fontSize: 12,
    letterSpacing: 1,
    color: "rgba(246,247,248,0.4)",
  },
  balance: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    color: "rgba(246,247,248,0.3)",
  },
  legRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  tokenButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: colors.surfaceMd,
  },
  tokenDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.goldSoft,
    borderWidth: 1,
    borderColor: colors.goldBorder,
  },
  tokenCode: {
    fontFamily: fontFamily.bodySemiBold,
    fontSize: 15,
    color: colors.offWhite,
  },
  chevron: {
    fontSize: 12,
    color: colors.textMuted,
  },
  amountInput: {
    flex: 1,
    fontFamily: fontFamily.body,
    fontSize: 24,
    color: colors.offWhite,
    padding: 0,
  },
  amountOut: {
    color: "rgba(246,247,248,0.45)",
  },
  quoteSpinner: {
    flex: 1,
    alignSelf: "center",
  },
  flipWrap: {
    alignItems: "center",
    marginVertical: -4,
  },
  flipButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surfaceMd,
    borderWidth: 1,
    borderColor: colors.borderDim,
    alignItems: "center",
    justifyContent: "center",
  },
  flipIcon: {
    fontSize: 18,
    color: colors.gold,
    lineHeight: 20,
  },
  quote: {
    padding: 16,
    gap: 4,
  },
  quoteTitle: {
    fontFamily: fontFamily.bodySemiBold,
    fontSize: 14,
    color: colors.offWhite,
  },
  quoteBody: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textMuted,
  },
  quoteErrorText: {
    color: colors.teal,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  infoLabel: {
    fontFamily: fontFamily.body,
    fontSize: 13,
    color: colors.textMuted,
    flex: 1,
  },
  infoValue: {
    fontFamily: fontFamily.bodyMedium,
    fontSize: 13,
    color: colors.offWhite,
    textAlign: "right",
    flex: 1,
  },
  // Modal
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    backgroundColor: "#141418",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: colors.borderDim,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 32,
    gap: 4,
  },
  sheetTitle: {
    fontFamily: fontFamily.accent,
    fontSize: 12,
    letterSpacing: 1,
    color: colors.textMuted,
    marginBottom: 8,
  },
  tokenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
  },
  tokenRowText: {
    flex: 1,
  },
  tokenRowCode: {
    fontFamily: fontFamily.bodySemiBold,
    fontSize: 15,
    color: colors.offWhite,
  },
  tokenRowName: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  // Confirm
  confirmCard: {
    padding: 20,
    gap: 2,
  },
  secondaryBtn: {
    marginTop: 8,
  },
  // Status screens
  statusWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  spinner: {
    marginBottom: 8,
  },
  statusTitle: {
    fontFamily: fontFamily.bodySemiBold,
    fontSize: 18,
    color: colors.offWhite,
    textAlign: "center",
  },
  statusBody: {
    fontFamily: fontFamily.body,
    fontSize: 14,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 21,
  },
  successCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.goldSoft,
    borderWidth: 1,
    borderColor: colors.goldBorder,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  successIcon: {
    fontSize: 28,
    color: colors.gold,
  },
  errorCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(0,167,181,0.08)",
    borderWidth: 1,
    borderColor: "rgba(0,167,181,0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  errorCircleIcon: {
    fontSize: 28,
    color: colors.teal,
  },
  hash: {
    fontFamily: fontFamily.body,
    fontSize: 12,
    color: "rgba(246,247,248,0.3)",
    marginTop: 4,
  },
});
