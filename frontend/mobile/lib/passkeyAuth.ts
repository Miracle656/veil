import { webAuthnProvider } from "invisible-wallet-sdk";
import * as SecureStore from "expo-secure-store";
import { getRandomBytes } from "expo-crypto";

const RP_ID =
  process.env["EXPO_PUBLIC_RP_ID"]?.trim() || "localhost";

/**
 * Prompt the user's registered passkey (Face ID / fingerprint / PIN) to
 * authorise a sensitive action. Throws if verification fails or is cancelled.
 *
 * NOTE: The challenge generation and assertion check below are performed
 * client-side and act as a local UX gate rather than server-verified
 * authentication. A production server should independently verify the
 * assertion to guarantee authenticity.
 */
export async function requirePasskey(): Promise<void> {
  const keyId = await SecureStore.getItemAsync("invisible_wallet_key_id");
  if (!keyId)
    throw new Error("No passkey found. Please register the wallet first.");

  const challenge = getRandomBytes(32).buffer as ArrayBuffer;

  const assertion = await webAuthnProvider.authenticate({
    challenge,
    credentialId: keyId,
    rpId: RP_ID,
  });

  if (!assertion) throw new Error("Passkey verification was cancelled.");
}
