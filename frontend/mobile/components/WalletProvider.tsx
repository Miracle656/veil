import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Keypair } from "@stellar/stellar-sdk";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { useInvisibleWallet, type StorageAdapter } from "@veil/sdk";

import { getNetwork, getNetworkName, subscribeToNetwork } from "../lib/network";
import { getRelyingPartyId, getWebAuthnOrigin } from "../lib/relyingParty";
import { getWalletAddress, getSignerSecret } from "../lib/walletStore";

// ── Persisted session keys (expo-secure-store) ───────────────────────────────

const SESSION_ADDRESS_KEY = "veil_wallet_session_address";
const SESSION_SIGNER_SECRET_KEY = "veil_wallet_session_signer_secret";

// ── Types ────────────────────────────────────────────────────────────────────

interface WalletSession {
  address: string;
  signerKeypair: Keypair;
}

interface WalletContextValue {
  session: WalletSession | null;
  setSession: (s: WalletSession | null) => void;
  wallet: ReturnType<typeof useInvisibleWallet>;
  clearSession: () => void;
}

// ── Context ──────────────────────────────────────────────────────────────────

const WalletContext = createContext<WalletContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<WalletSession | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // The SDK persists wallet credentials (key ID, public key, address) in
  // AsyncStorage.  The mobile WalletProvider separately persists the session
  // (signer keypair) in expo-secure-store so the fee-payer secret survives the
  // app being backgrounded or killed by the OS.  (The web wallet keeps the
  // signer keypair in React state only.)
  // Namespaced per network, matching lib/walletStore.ts. The SDK writes its
  // credential id, public key and address under fixed keys, so with a raw
  // AsyncStorage adapter both networks shared one set. Two consequences, both
  // seen in practice:
  //
  //   • Registering on one network passed the OTHER network's credential id as
  //     excludeCredentials, and since that passkey really is on the device the
  //     platform refused with "one of the excluded credentials exists on the
  //     local device" — leaving no way to create the second wallet at all.
  //   • "Reset wallet" cleared the namespaced secure-store keys but not these,
  //     so a reset did not actually reset.
  //
  // Testnet keeps the bare keys so existing installs are untouched; mainnet
  // takes the suffix. Same convention as walletStore, deliberately.
  const networkName = useSyncExternalStore(subscribeToNetwork, getNetworkName, getNetworkName);

  const storage: StorageAdapter = useMemo(() => {
    const scope = (k: string) => (networkName === 'mainnet' ? `${k}_mainnet` : k);
    return {
      getItem: (k: string) => AsyncStorage.getItem(scope(k)),
      setItem: (k: string, v: string) => AsyncStorage.setItem(scope(k), v),
      removeItem: (k: string) => AsyncStorage.removeItem(scope(k)),
    };
  }, [networkName]);

  // LIVE per-network SDK config. The old module-level walletConfig const was
  // evaluated before the stored network override hydrated, so on mainnet the
  // SDK silently kept TESTNET factory/rpc/passphrase — wallet addresses were
  // derived with the wrong network and deploys hit the wrong Horizon.
  const liveConfig = useMemo(() => {
    const net = getNetwork();
    return {
      factoryAddress: net.factoryContractId,
      rpcUrl: net.rpcUrl,
      networkPassphrase: net.networkPassphrase,
      rpId: getRelyingPartyId(),
      origin: getWebAuthnOrigin(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networkName]);
  const wallet = useInvisibleWallet({ ...liveConfig, storage });

  // Hydrate the session from expo-secure-store on first mount.
  useEffect(() => {
    (async () => {
      try {
        const [address, signerSecret] = await Promise.all([
          getWalletAddress(),
          getSignerSecret(),
        ]);
        if (address && signerSecret) {
          setSessionState({
            address,
            signerKeypair: Keypair.fromSecret(signerSecret),
          });
        }
      } catch (e) {
        console.warn("[WalletProvider] failed to hydrate session", e);
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  const setSession = useCallback(
    async (s: WalletSession | null) => {
      setSessionState(s);
      // Persist or clear the fee-payer secret in the OS keychain.
      try {
        if (s) {
          await SecureStore.setItemAsync(SESSION_ADDRESS_KEY, s.address);
          await SecureStore.setItemAsync(
            SESSION_SIGNER_SECRET_KEY,
            s.signerKeypair.secret(),
          );
        } else {
          await SecureStore.deleteItemAsync(SESSION_ADDRESS_KEY);
          await SecureStore.deleteItemAsync(SESSION_SIGNER_SECRET_KEY);
        }
      } catch (e) {
        console.warn("[WalletProvider] failed to persist session", e);
      }
    },
    [],
  );

  const clearSession = useCallback(() => {
    setSession(null);
  }, [setSession]);

  // Render nothing until hydration is complete so that children always see
  // a consistent session (either the restored one or null).
  if (!hydrated) {
    return null;
  }

  return (
    <WalletContext.Provider
      value={{ session, setSession, wallet, clearSession }}
    >
      {children}
    </WalletContext.Provider>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used inside WalletProvider");
  }
  return ctx;
}
