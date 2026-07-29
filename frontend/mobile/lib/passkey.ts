import * as Passkeys from 'react-native-passkeys';

import {
  registerAuthEntrySigner,
  type AuthEntrySigner,
  type WebAuthnSignature,
} from './walletConnect';
import { isUserRejection } from './walletConnectHelpers';
import { getPasskeyId, getPasskeyPublicKey } from './walletStore';
import { base64UrlToUint8Array, derToRawSignature, hexToUint8Array, uint8ArrayToBase64Url } from './webauthn';

/**
 * Device passkey signer.
 *
 * The browser wallet calls `navigator.credentials.get()` directly; on mobile the
 * equivalent is `react-native-passkeys`, which speaks the JSON WebAuthn dialect
 * (every binary field base64url-encoded) and prompts Face ID / fingerprint /
 * device PIN through the platform authenticator.
 *
 * The Soroban authorization-entry hash is passed as the WebAuthn challenge, so
 * the assertion the authenticator produces is a signature over exactly the
 * payload the wallet contract will verify.
 */

/** Relying-party id the passkey was registered against. */
function getRelyingPartyId(): string | undefined {
  return process.env['EXPO_PUBLIC_PASSKEY_RP_ID']?.trim() || undefined;
}

export function isPasskeySupported(): boolean {
  try {
    return Passkeys.isSupported();
  } catch {
    return false;
  }
}

/**
 * Prompt the device passkey to sign one Soroban authorization-entry hash.
 *
 * Resolves to null when the user dismisses the prompt, so callers can treat a
 * decline as a rejection rather than a failure. Throws when the wallet has no
 * registered passkey or the platform reports a genuine error.
 */
export async function signPayloadWithPasskey(
  payloadHash: Uint8Array
): Promise<WebAuthnSignature | null> {
  const [keyId, publicKeyHex] = await Promise.all([getPasskeyId(), getPasskeyPublicKey()]);
  if (!keyId || !publicKeyHex) {
    throw new Error('No passkey found on this device. Register the wallet first.');
  }

  if (!isPasskeySupported()) {
    throw new Error('Passkeys are not supported on this device.');
  }

  let assertion: Awaited<ReturnType<typeof Passkeys.get>>;
  try {
    assertion = await Passkeys.get({
      challenge: uint8ArrayToBase64Url(payloadHash),
      rpId: getRelyingPartyId(),
      allowCredentials: [{ id: keyId, type: 'public-key' }],
      userVerification: 'required',
      timeout: 60_000,
    });
  } catch (error: unknown) {
    if (isUserRejection(error)) return null;
    throw error;
  }

  // The platform returns null when the sheet is dismissed without a selection.
  if (!assertion) return null;

  return {
    publicKey: hexToUint8Array(publicKeyHex),
    authData: base64UrlToUint8Array(assertion.response.authenticatorData),
    clientDataJSON: base64UrlToUint8Array(assertion.response.clientDataJSON),
    signature: derToRawSignature(base64UrlToUint8Array(assertion.response.signature)),
  };
}

/**
 * Make {@link signPayloadWithPasskey} the signer used for dApp requests.
 * Returns an unregister function.
 */
export function registerPasskeySigner(): () => void {
  const signer: AuthEntrySigner = (payloadHash) => signPayloadWithPasskey(payloadHash);
  return registerAuthEntrySigner(signer);
}
