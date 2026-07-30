import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { Button, Card, Screen } from "../components/ui";
import { colors } from "../theme/colors";
import { fontFamily, typography } from "../theme/typography";

type Token = { code: string; name: string };

const TOKENS: Token[] = [
  { code: "XLM", name: "Stellar Lumens" },
  { code: "USDC", name: "USD Coin" },
  { code: "EURC", name: "Euro Coin" },
  { code: "AQUA", name: "Aquarius" },
];

/**
 * Swap surface (`/swap`) — ports the layout of the web wallet's swap page
 * (`frontend/wallet/app/swap/page.tsx`): in/out token selectors and the amount
 * input. Quoting (backlog #45) and execution (backlog #46) fill in later, so
 * the receive amount and quote area render an empty state for now.
 */
export default function SwapScreen() {
  const [tokenIn, setTokenIn] = useState<Token>(TOKENS[0]!);
  const [tokenOut, setTokenOut] = useState<Token>(TOKENS[1]!);
  const [amountIn, setAmountIn] = useState("");
  const [picker, setPicker] = useState<null | "in" | "out">(null);

  const hasAmount = Number(amountIn) > 0;

  function handleSelect(token: Token) {
    if (picker === "in") {
      if (token.code === tokenOut.code) setTokenOut(tokenIn);
      setTokenIn(token);
    } else if (picker === "out") {
      if (token.code === tokenIn.code) setTokenIn(tokenOut);
      setTokenOut(token);
    }
    setPicker(null);
  }

  function flip() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
  }

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
              onChangeText={setAmountIn}
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
            <Text style={[styles.amountInput, styles.amountOut]}>0.00</Text>
          </View>
        </Card>

        {/* Quote area — empty until quoting lands (backlog #45) */}
        <Card variant="md" style={styles.quote}>
          <Text style={styles.quoteTitle}>{hasAmount ? "No quote yet" : "Enter an amount"}</Text>
          <Text style={styles.quoteBody}>
            {hasAmount
              ? "Live quotes arrive in a later update."
              : "Enter an amount above to see what you’ll receive."}
          </Text>
        </Card>

        <Button label="Review swap" variant="gold" disabled={!hasAmount} />
      </ScrollView>

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
});
