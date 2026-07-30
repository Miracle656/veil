import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ConnectDAppModal } from "../components/ConnectDAppModal";
import { useWalletConnect } from "../hooks/useWalletConnect";
import { ThemeToggle } from "../components/ThemeToggle";
import { useTheme } from "../hooks/useTheme";
import type { ThemeColors } from "../lib/theme";

export default function Home() {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { sessions, disconnectSession } = useWalletConnect();
  const [isConnectOpen, setIsConnectOpen] = useState(false);

  return (
    <View style={styles.container}>
      <ThemeToggle style={styles.toggle} />
      <Text style={styles.title}>Veil Mobile</Text>
      <Text style={styles.subtitle}>Placeholder home route — toolchain is live.</Text>

      <Pressable
        accessibilityRole="button"
        onPress={() => setIsConnectOpen(true)}
        style={({ pressed }) => [styles.connectButton, pressed && styles.pressed]}
      >
        <Text style={styles.connectLabel}>Connect dApp</Text>
      </Pressable>

      {sessions.length > 0 && (
        <View style={styles.sessions}>
          <Text style={styles.sessionsTitle}>Connected dApps</Text>
          {sessions.map((session) => (
            <View key={session.topic} style={styles.sessionRow}>
              <Text style={styles.sessionName} numberOfLines={1}>
                {session.peer?.name || "Unknown dApp"}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  disconnectSession(session.topic).catch(() => {});
                }}
              >
                <Text style={styles.disconnect}>Disconnect</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}

      <ConnectDAppModal isOpen={isConnectOpen} onClose={() => setIsConnectOpen(false)} />
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.background,
      padding: 24,
    },
    toggle: {
      position: "absolute",
      top: 64,
      right: 24,
    },
    title: {
      color: colors.textStrong,
      fontSize: 28,
      fontWeight: "700",
    },
    subtitle: {
      color: colors.textSecondary,
      fontSize: 15,
      marginTop: 8,
      textAlign: "center",
    },
    connectButton: {
      marginTop: 24,
      backgroundColor: colors.accent,
      borderRadius: 999,
      paddingVertical: 12,
      paddingHorizontal: 28,
    },
    pressed: {
      opacity: 0.75,
    },
    connectLabel: {
      color: colors.background,
      fontSize: 15,
      fontWeight: "700",
    },
    sessions: {
      alignSelf: "stretch",
      marginTop: 28,
      gap: 8,
    },
    sessionsTitle: {
      color: colors.textFaint,
      fontSize: 12,
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    sessionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
    },
    sessionName: {
      color: colors.textPrimary,
      fontSize: 14,
      flexShrink: 1,
    },
    disconnect: {
      color: colors.accentText,
      fontSize: 13,
      fontWeight: "600",
    },
  });
