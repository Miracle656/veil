import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { colors } from "../lib/theme";

/**
 * Placeholder send screen. Signing and submission land with the wallet SDK
 * wiring; what matters here is that this route owns the prefill contract deep
 * links depend on — `to`, `amount`, `asset`, and `memo` arrive as query
 * parameters from `veil://send`, `https://app.veil.xyz/send`, or a SEP-7
 * request forwarded by `/pay`.
 */
export default function Send() {
  const params = useLocalSearchParams<{
    to?: string;
    amount?: string;
    asset?: string;
    memo?: string;
  }>();

  const [recipient, setRecipient] = useState(firstValue(params.to));
  const [amount, setAmount] = useState(firstValue(params.amount));
  const asset = firstValue(params.asset) || "XLM";
  const memo = firstValue(params.memo);

  return (
    <View style={styles.container} testID="send-screen">
      <Text style={styles.title}>Send</Text>

      <TextInput
        testID="send-recipient-input"
        accessibilityLabel="Recipient address"
        placeholder="Recipient address (G… or C…)"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        value={recipient}
        onChangeText={setRecipient}
        style={styles.input}
      />

      <TextInput
        testID="send-amount-input"
        accessibilityLabel="Amount"
        placeholder={`Amount in ${asset}`}
        placeholderTextColor={colors.muted}
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={setAmount}
        style={styles.input}
      />

      {memo ? (
        <Text testID="send-memo" style={styles.memo}>
          Memo: {memo}
        </Text>
      ) : null}
    </View>
  );
}

/** expo-router yields `string | string[]` for a repeated query key. */
function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: colors.background,
    gap: 16,
    padding: 24,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 16,
    padding: 14,
  },
  memo: {
    color: colors.muted,
    fontSize: 14,
  },
});
