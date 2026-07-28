import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ConnectDAppModal } from "../components/ConnectDAppModal";
import { useWalletConnect } from "../hooks/useWalletConnect";

export default function Home() {
  const { sessions, disconnectSession } = useWalletConnect();
  const [isConnectOpen, setIsConnectOpen] = useState(false);

  return (
    <View style={styles.container}>
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
    fontSize: 28,
    fontWeight: "700",
  },
  subtitle: {
    color: "#9BA1A6",
    fontSize: 15,
    marginTop: 8,
    textAlign: "center",
  },
  connectButton: {
    marginTop: 24,
    backgroundColor: "#FDDA24",
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  pressed: {
    opacity: 0.75,
  },
  connectLabel: {
    color: "#0F0F0F",
    fontSize: 15,
    fontWeight: "700",
  },
  sessions: {
    alignSelf: "stretch",
    marginTop: 28,
    gap: 8,
  },
  sessionsTitle: {
    color: "rgba(246,247,248,0.45)",
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
    borderColor: "rgba(246,247,248,0.14)",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  sessionName: {
    color: "#F6F7F8",
    fontSize: 14,
    flexShrink: 1,
  },
  disconnect: {
    color: "#FDDA24",
    fontSize: 13,
    fontWeight: "600",
  },
});
