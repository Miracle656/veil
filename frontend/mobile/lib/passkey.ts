import * as Crypto from 'expo-crypto';
// react-native-passkeys is a NATIVE module absent in Expo Go: a top-level import
// crashes the app at startup (this file loads via _layout → WalletConnectApprovalModal
// → registerPasskeySigner). Load it lazily so the app boots in Expo Go; a passkey
// ceremony throws a clear "use a dev build" error only when actually invoked. The
// type-only import is erased at compile time and never triggers the native require.
import type * as PasskeysModule from 'react-native-passkeys';

let cachedPasskeys: typeof PasskeysModule | null | undefined;
function loadPasskeys(): typeof PasskeysModule | null {
  if (cachedPasskeys !== undefined) return cachedPasskeys;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedPasskeys = require('react-native-passkeys') as typeof PasskeysModule;
  } catch {
    cachedPasskeys = null;
  }
  return cachedPasskeys;
}

function passkeys(): typeof PasskeysModule {
  const m = loadPasskeys();
  if (!m) {
    throw new Error(
      'Native passkeys are unavailable in this build. Expo Go cannot load the ' +
        'react-native-passkeys native module — use a development build.',
    );
  }
  return m;
}

import {
  registerAuthEntrySigner,
  type AuthEntrySigner,
  type WebAuthnSignature,
} from './walletConnect';
import { isUserRejection } from './walletConnectHelpers';
import { getPasskeyId, getPasskeyPublicKey, getSignerSecret } from './walletStore';
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

export { getRelyingPartyId } from './relyingParty';
import { getRelyingPartyId } from './relyingParty';

export function isPasskeySupported(): boolean {
  try {
    return passkeys().isSupported();
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

  let assertion: Awaited<ReturnType<typeof PasskeysModule.get>>;
  try {
    assertion = await passkeys().get({
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

/**
 * Gate a sensitive action behind the device passkey.
 *
 * Mirrors `requirePasskey` in the web wallet: assert over a fresh random
 * challenge so the user proves presence before anything is built or submitted.
 * Throws when the sheet is dismissed, so a caller can abort rather than sign.
 */
export async function requirePasskey(): Promise<void> {
  const keyId = await getPasskeyId();

  if (!keyId) {
    // Plain testnet-keypair mode (no passkey registered): the stored signer
    // secret authorises directly — nothing to assert against.
    if (await getSignerSecret()) return;
    throw new Error('No passkey found on this device. Register the wallet first.');
  }

  // A passkey exists → every sensitive action demands user presence, even
  // though the classic transaction is signed by the fee-payer keypair. The
  // assertion is over a fresh random challenge (presence gate, not an
  // on-chain signature), so it needs only the credential id.
  try {
    const assertion = await passkeys().get({
      challenge: uint8ArrayToBase64Url(Crypto.getRandomBytes(32)),
      rpId: getRelyingPartyId(),
      allowCredentials: [{ id: keyId, type: 'public-key' }],
      userVerification: 'required',
      timeout: 60_000,
    });
    if (!assertion) throw new Error('Passkey cancelled. Please try again.');
  } catch (error: unknown) {
    if (isUserRejection(error)) throw new Error('Passkey cancelled. Please try again.');
    throw error;
  }
}

/**
 * A native `PrfEvaluator` (SDK shape: `(salt) => Promise<Uint8Array | null>`)
 * backed by the WebAuthn PRF extension via react-native-passkeys. Runs a passkey
 * assertion requesting `prf.eval.first = salt` and returns the PRF output, or
 * null when PRF is unsupported / the user declines. Used to derive the fee-payer
 * key deterministically from the passkey.
 */
function parsePrfOutput(assertion: unknown): Uint8Array | null {
  const results = (assertion as { clientExtensionResults?: { prf?: { results?: { first?: unknown } } } })
    ?.clientExtensionResults?.prf?.results?.first;
  if (!results) return null;
  if (typeof results === 'string') return base64UrlToUint8Array(results);
  if (results instanceof ArrayBuffer) return new Uint8Array(results);
  if (ArrayBuffer.isView(results)) return new Uint8Array(results.buffer as ArrayBuffer);
  return null;
}

export function nativePrfEvaluator(credentialId: string): (salt: Uint8Array) => Promise<Uint8Array | null> {
  return async (salt: Uint8Array) => {
    try {
      const assertion = await passkeys().get({
        challenge: uint8ArrayToBase64Url(Crypto.getRandomBytes(32)),
        rpId: getRelyingPartyId(),
        allowCredentials: [{ id: credentialId, type: 'public-key' }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: uint8ArrayToBase64Url(salt) } } },
      });
      return parsePrfOutput(assertion);
    } catch {
      return null;
    }
  };
}

/**
 * Discoverable assertion + PRF in ONE user gesture: no allowCredentials, so the
 * platform sheet lists every passkey for the relying party and the user picks.
 * Returns the chosen credential id and the PRF output for `salt` — the two
 * facts "sign in with passkey" needs to re-derive the wallet on a fresh device.
 */
export async function discoverWithPrf(
  salt: Uint8Array,
): Promise<{ credentialId: string; prf: Uint8Array | null } | null> {
  try {
    const assertion = await passkeys().get({
      challenge: uint8ArrayToBase64Url(Crypto.getRandomBytes(32)),
      rpId: getRelyingPartyId(),
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: uint8ArrayToBase64Url(salt) } } },
    });
    if (!assertion) return null;
    const credentialId = (assertion as { id?: string; rawId?: string }).id
      ?? (assertion as { id?: string; rawId?: string }).rawId;
    if (!credentialId) return null;
    return { credentialId, prf: parsePrfOutput(assertion) };
  } catch (error: unknown) {
    if (isUserRejection(error)) return null;
    throw error;
  }
}
