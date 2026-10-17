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
import { prfFromAssertion, prfFromError, type PrfEvaluation } from './prfOutcome';
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
 * Whether the platform is telling us the credential does not exist here.
 *
 * This is not the same as "no passkey is registered": the credential id and its
 * public key can be sitting in secure storage while the OS holds nothing that
 * matches, because a passkey is bound to the relying party it was created
 * against. Veil's RP moved to app.useveilapp.xyz on 2026-08-22, so wallets
 * created before that — in practice the older testnet ones — still have stored
 * credentials that no assertion can ever satisfy (see lib/relyingParty.ts).
 *
 * Worth naming precisely, because the raw platform error reads as "couldn't
 * find a passkey", which sounds like nothing is registered and sends you
 * looking in the wrong place.
 */
function isCredentialNotFound(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return (
    message.includes('no credentials') ||
    message.includes('not found') ||
    message.includes('no passkey') ||
    message.includes('nomatchingcredential') ||
    message.includes('no matching credential')
  );
}

/** The message shown when a stored credential no longer resolves on-device. */
export const CREDENTIAL_ORPHANED_MESSAGE =
  'This wallet’s passkey was created against an earlier Veil domain, so this device can no longer use it. ' +
  'Create a new wallet on this network — your wallets on other networks are unaffected.';

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
    if (isCredentialNotFound(error)) throw new Error(CREDENTIAL_ORPHANED_MESSAGE);
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

/**
 * Evaluate PRF for `salt` on one credential, and say why when there is no
 * output: an unsupported password manager, a closed prompt, or an error.
 */
export async function evaluatePrf(credentialId: string, salt: Uint8Array): Promise<PrfEvaluation> {
  try {
    const assertion = await passkeys().get({
      challenge: uint8ArrayToBase64Url(Crypto.getRandomBytes(32)),
      rpId: getRelyingPartyId(),
      allowCredentials: [{ id: credentialId, type: 'public-key' }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: uint8ArrayToBase64Url(salt) } } },
    });
    return prfFromAssertion(!!assertion, assertion ? parsePrfOutput(assertion) : null);
  } catch (error: unknown) {
    return prfFromError(error);
  }
}

export function nativePrfEvaluator(credentialId: string): (salt: Uint8Array) => Promise<Uint8Array | null> {
  return async (salt: Uint8Array) => (await evaluatePrf(credentialId, salt)).output;
}

/**
 * A discovered assertion: one pic-and-tap passkey gesture, plus the pieces of
 * the resulting WebAuthn assertion that let a caller verify the credential's
 * public key against a candidate set (the assertion itself never reveals it)
 * and the PRF output for the requested salt, which is null when the credential
 * or its manager has no PRF.
 */
export type DiscoveredPasskey = {
  /** The picked credential's id (base64url). */
  credentialId: string;
  /** Raw P-256 ECDSA signature (64 bytes, r‖s, low-S). */
  signature: Uint8Array;
  /** The authenticator's signed statement (RP hash at bytes 0..31). */
  authData: Uint8Array;
  /** The caller's challenge, origin and type, as the authenticator saw them. */
  clientDataJSON: Uint8Array;
  /** PRF output for the requested salt, or null when unavailable. */
  prf: Uint8Array | null;
};

/**
 * Discoverable assertion + PRF in ONE user gesture: no allowCredentials, so the
 * platform sheet lists every passkey for the relying party and the user picks.
 * Returns the chosen credential id, the assertion pieces (signature / authData /
 * clientDataJSON), and the PRF output for `salt` — the facts "sign in with
 * passkey" needs to re-derive the wallet on a fresh device. PRF stays optional:
 * a manager without it returns `prf: null`, it never makes the gesture fail.
 */
export async function discoverWithPrf(
  salt: Uint8Array,
): Promise<DiscoveredPasskey | null> {
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
    return {
      credentialId,
      signature: derToRawSignature(base64UrlToUint8Array(assertion.response.signature)),
      authData: base64UrlToUint8Array(assertion.response.authenticatorData),
      clientDataJSON: base64UrlToUint8Array(assertion.response.clientDataJSON),
      prf: parsePrfOutput(assertion),
    };
  } catch (error: unknown) {
    if (isUserRejection(error)) return null;
    throw error;
  }
}

/** The pieces of an assertion that let a caller recover the signing public key. */
export type RecoveryAssertion = {
  /** The credential that actually signed (the user may pick in the sheet). */
  credentialId: string;
  /** Raw P-256 ECDSA signature (64 bytes, r‖s, low-S). */
  signature: Uint8Array;
  authData: Uint8Array;
  clientDataJSON: Uint8Array;
};

/**
 * One assertion over a fresh random challenge, for public-key recovery.
 *
 * Targeted at `credentialId` when the device still has it, so the user is asked
 * about their own wallet rather than shown a picker. With no stored id it falls
 * back to a discoverable assertion — the wallet whose key we are trying to
 * recover may be exactly the one whose credential id went missing.
 *
 * The challenge is random because nothing on chain consumes this signature; it
 * exists only so the authenticator reveals, by signing, which key it holds.
 */
export async function assertForKeyRecovery(
  credentialId: string | null,
): Promise<RecoveryAssertion | null> {
  try {
    const assertion = await passkeys().get({
      challenge: uint8ArrayToBase64Url(Crypto.getRandomBytes(32)),
      rpId: getRelyingPartyId(),
      ...(credentialId ? { allowCredentials: [{ id: credentialId, type: 'public-key' as const }] } : {}),
      userVerification: 'required',
      timeout: 60_000,
    });
    if (!assertion) return null;
    const picked =
      (assertion as { id?: string; rawId?: string }).id ??
      (assertion as { id?: string; rawId?: string }).rawId ??
      credentialId;
    if (!picked) return null;
    return {
      credentialId: picked,
      signature: derToRawSignature(base64UrlToUint8Array(assertion.response.signature)),
      authData: base64UrlToUint8Array(assertion.response.authenticatorData),
      clientDataJSON: base64UrlToUint8Array(assertion.response.clientDataJSON),
    };
  } catch (error: unknown) {
    if (isUserRejection(error)) return null;
    if (isCredentialNotFound(error)) throw new Error(CREDENTIAL_ORPHANED_MESSAGE);
    throw error;
  }
}

/**
 * Whether Android is saying it has nowhere to put a passkey.
 *
 * `createCredentialAsync no provider dependencies found` comes from Android's
 * Credential Manager, not from us. The app ships both halves it needs
 * (`androidx.credentials` and `credentials-play-services-auth`, declared by
 * react-native-passkeys), so this is the device answering: no credential
 * provider is installed or switched on, most often because Google Password
 * Manager is disabled as a passkey provider, Play Services is stale, or no
 * Google account is signed in.
 *
 * Worth naming because the raw string reads like a missing build dependency —
 * it sent us looking at our own gradle file first — and a user shown it has no
 * idea the fix is three taps away in their own settings.
 */
export function isNoCredentialProvider(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return (
    message.includes('no provider dependencies') ||
    message.includes('no create options') ||
    (message.includes('provider') && message.includes('createcredential'))
  );
}

/**
 * What to tell someone whose phone has no passkey provider switched on.
 *
 * The screen lock is first because it is the one people have genuinely not got,
 * and Google Password Manager refuses to create a passkey without one — the
 * passkey is released by that lock, so there is nothing to hold it shut
 * otherwise. The Google path is given before the Xiaomi one because it is the
 * same on every skin; the per-manufacturer menus move between OS versions, and
 * on HyperOS the autofill setting is not under anything called "passwords".
 */
export const NO_CREDENTIAL_PROVIDER_MESSAGE =
  'This phone has no passkey provider switched on, so Android has nowhere to save it. ' +
  'First set a screen lock (PIN, pattern or fingerprint) — a passkey cannot be created ' +
  'without one. Then open Settings → Google → All services → Autofill & Passwords and ' +
  'turn on "Autofill with Google". On Xiaomi and Redmi it may instead be under ' +
  'Settings → Additional settings → Languages & input → Autofill service — pick Google there.';

/**
 * Whether the platform refused because this device already holds a Veil passkey.
 *
 * The SDK passes the stored credential id as `excludeCredentials` so one device
 * cannot register twice for the same wallet, and Android enforces that by
 * refusing outright: "One of the excluded credentials exists on the local
 * device." The raw string names a WebAuthn mechanism and no action, so it reads
 * as a failure when it is in fact the platform saying the thing already exists.
 *
 * Two ways to arrive here, with opposite fixes, which is why the message offers
 * both: a wallet is already set up on this device and should be signed into
 * rather than recreated, or a reset left the SDK's credential id behind while
 * clearing the secure store, so the app wants to create a wallet the OS thinks
 * it already has.
 */
export function isExcludedCredentialExists(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return (
    message.includes('excluded credential') ||
    message.includes('excludecredentials') ||
    message.includes('already registered')
  );
}

/** What to tell someone whose device already holds a passkey for this wallet. */
export const CREDENTIAL_ALREADY_EXISTS_MESSAGE =
  'This device already has a Veil passkey, so a new one cannot be created over it. ' +
  'If you already have a wallet here, go back and sign in with it instead. ' +
  'If you meant to start fresh, reset the wallet first in Settings \u2192 Danger zone \u2014 ' +
  'that clears the old credential so a new one can be created.';
