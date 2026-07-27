import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";

export default function SwapScreen() {
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Swap", headerShown: true }} />
      <Text style={styles.title}>Swap</Text>
      <Text style={styles.subtitle}>Swap tokens instantly on Soroban DEX</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0B0B0F",
    padding: 24,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 24,
    fontWeight: "700",
  },
  subtitle: {
    color: "#9BA1A6",
    fontSize: 15,
    marginTop: 8,
    textAlign: "center",
  },
});
