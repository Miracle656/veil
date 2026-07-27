import { useState, useCallback } from "react";
import { useRouter } from "expo-router";
import { LockKeyhole, Fingerprint, AlertCircle } from "lucide-react-native";
import { requirePasskey } from "@/lib/passkeyAuth";
import { useInvisibleWallet } from "@/lib/wallet";

// ── Restore screen ───────────────────────────────────────────────────────────────
export default function RestorePage() {
  const router = useRouter();

  const [error, setError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);

  const wallet = useInvisibleWallet({
    factoryAddress: "CABQJUL4WFJNXN5DKTO5I56H3KUKVBLG4QKHEDFNX5AU2LTFSKVD5YOW",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  });

  const handleRestore = useCallback(async () => {
    setError(null);
    setIsUnlocking(true);

    try {
      const keyId = localStorage.getItem("invisible_wallet_key_id");
      if (!keyId) {
        setError("No passkey found. Please register again.");
        return;
      }

      if (keyId === "recovery") {
        setError("Recovery passkey detected. Please log in again.");
        return;
      }

      await requirePasskey();

      const result = await wallet.login();

      if (!result?.walletAddress) {
        setError("No wallet found. Please register again.");
        return;
      }

      const existing = sessionStorage.getItem("invisible_wallet_address");
      if (existing && existing !== result.walletAddress) {
        sessionStorage.clear();
        setError("Account mismatch detected. Please register again.");
        return;
      }
      sessionStorage.setItem("invisible_wallet_address", result.walletAddress);

      router.replace("/(tabs)/dashboard");
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Restore failed. Please try again.";
      setError(message);
    } finally {
      setIsUnlocking(false);
    }
  }, [wallet, router]);

  return (
    <div
      className="wallet-shell"
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: "2rem 1.25rem",
      }}
    >
      <div
        style={{
          maxWidth: 400,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "2.5rem",
        }}
      >
        <header
          style={{
            padding: "1rem 1.25rem",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontFamily: "Anton, Impact, sans-serif",
              fontSize: "2rem",
              letterSpacing: "0.08em",
              color: "var(--gold)",
              userSelect: "none",
            }}
          >
            VEIL
          </span>
        </header>

        <main
          style={{
            flex: 1,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: "2rem 1.25rem",
          }}
        >
          <div
            className="card"
            style={{
              maxWidth: 400,
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "2.5rem",
            }}
          >
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: "50%",
                background: "var(--surface-md)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <LockKeyhole
                size={28}
                color="rgba(246,247,248,0.6)"
                strokeWidth={1.5}
              />
            </div>

            <div
              style={{
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                gap: "0.375rem",
              }}
            >
              <h1
                style={{
                  fontFamily: "Lora, Georgia, serif",
                  fontWeight: 600,
                  fontStyle: "italic",
                  fontSize: "1.25rem",
                  color: "var(--off-white)",
                }}
              >
                Restore wallet
              </h1>
              <p className="text-muted">
                Use your existing passkey to restore your wallet.
              </p>
            </div>

            {error && (
              <div
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.625rem",
                  borderRadius: 12,
                  background: "rgba(239,68,68,0.10)",
                  border: "1px solid rgba(239,68,68,0.20)",
                  padding: "0.75rem 1rem",
                }}
              >
                <AlertCircle
                  size={16}
                  color="rgba(252,165,165,1)"
                  strokeWidth={1.5}
                  style={{ flexShrink: 0, marginTop: 2 }}
                />
                <p
                  style={{
                    fontSize: "0.875rem",
                    color: "rgba(252,165,165,1)",
                    lineHeight: 1.4,
                  }}
                >
                  {error}
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={handleRestore}
              disabled={isUnlocking}
              className="btn-gold"
            >
              <Fingerprint size={20} strokeWidth={1.5} />
              {isUnlocking ? "Restoring…" : "Restore with passkey"}
            </button>

            <p
              style={{
                fontSize: "0.75rem",
                color: "var(--color-muted)",
                textAlign: "center",
              }}
            >
              Your biometric is your key — no password needed.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
