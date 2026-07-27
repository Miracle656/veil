import { webAuthnProvider } from "invisible-wallet-sdk";

/**
 * Prompt the user's registered passkey (Face ID / fingerprint / PIN) to
 * authorise a sensitive action. Throws if verification fails or is cancelled.
 */
export async function requirePasskey(): Promise<void> {
  const keyId = localStorage.getItem("invisible_wallet_key_id");
  if (!keyId)
    throw new Error("No passkey found. Please register the wallet first.");

  const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = challengeBytes.buffer.slice(
    challengeBytes.byteOffset,
    challengeBytes.byteOffset + challengeBytes.byteLength
  ) as ArrayBuffer;

  const assertion = await webAuthnProvider.authenticate({
    challenge,
    credentialId: keyId,
    rpId: "localhost",
  });

  if (!assertion) throw new Error("Passkey verification was cancelled.");
}
