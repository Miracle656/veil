import AsyncStorage from '@react-native-async-storage/async-storage';

import { SecureKey, getSecureItem, setSecureItem, deleteSecureItem } from './storage';
import { getNetworkName, hydrateNetwork } from './network';

/**
 * Thin, typed accessors for the wallet identifiers the app keeps on the device.
 *
 * The browser wallet reads these from `sessionStorage` / `localStorage`; on
 * mobile they all route through the secure store (`lib/storage.ts`, backed by the
 * OS keychain), so wallet metadata survives relaunch and the fee-payer secret is
 * never written to plain application storage.
 *
 * PER-NETWORK NAMESPACING: mainnet and testnet each get their own wallet.
 * Testnet keeps the historical unsuffixed keys (back-compat with existing
 * installs); mainnet keys carry a `_mainnet` suffix. Without this, switching
 * networks showed the other network's wallet, and a "Reset wallet" on testnet
 * would have destroyed a REAL-funds mainnet wallet.
 */
async function key(base: SecureKey): Promise<string> {
  // The network override is read from storage at startup; awaiting hydration
  // prevents a cold-start race from reading the wrong network's keys.
  await hydrateNetwork();
  return getNetworkName() === 'mainnet' ? `${base}_mainnet` : base;
}

/** Deployed wallet contract address (`C...`), or null when not yet created. */
export async function getWalletAddress(): Promise<string | null> {
  return getSecureItem(await key(SecureKey.walletAddress));
}

export async function setWalletAddress(address: string): Promise<void> {
  return setSecureItem(await key(SecureKey.walletAddress), address);
}

/** Base64url credential id of the registered passkey. */
export async function getPasskeyId(): Promise<string | null> {
  return getSecureItem(await key(SecureKey.passkeyId));
}

export async function setPasskeyId(keyId: string): Promise<void> {
  return setSecureItem(await key(SecureKey.passkeyId), keyId);
}

/** Hex-encoded secp256r1 public key of the registered passkey. */
export async function getPasskeyPublicKey(): Promise<string | null> {
  return getSecureItem(await key(SecureKey.passkeyPublicKey));
}

export async function setPasskeyPublicKey(publicKey: string): Promise<void> {
  return setSecureItem(await key(SecureKey.passkeyPublicKey), publicKey);
}

/**
 * Whether this network has a wallet that can actually sign.
 *
 * Deliberately stricter than "is there an address". A credential id without its
 * public key produces assertions the wallet contract cannot verify, and the
 * signer secret is the fallback used by keypair-mode testnet wallets — so a
 * device can hold an address and still be unable to spend. That combination is
 * what surfaced as "No passkey found on this device" at the moment of a swap,
 * long after the network switch that caused it.
 *
 * One helper rather than the same three reads inlined per caller, so a screen
 * cannot drift into checking a weaker condition than the spend path enforces.
 */
export async function hasUsableWallet(): Promise<boolean> {
  const [address, keyId, publicKey, signerSecret] = await Promise.all([
    getWalletAddress().catch(() => null),
    getPasskeyId().catch(() => null),
    getPasskeyPublicKey().catch(() => null),
    getSignerSecret().catch(() => null),
  ]);
  if (!address) return false;
  // Either a complete passkey credential, or a keypair-mode signer.
  return (!!keyId && !!publicKey) || !!signerSecret;
}

/**
 * Adopt a passkey as this device's wallet credential.
 *
 * Both halves are written together — a credential id without its public key
 * produces assertions the wallet contract cannot verify.
 */
export async function setPasskeyCredential(keyId: string, publicKeyHex: string): Promise<void> {
  await Promise.all([setPasskeyId(keyId), setPasskeyPublicKey(publicKeyHex)]);
}

/** Stellar secret seed of the account that pays fees for wallet transactions. */
export async function getSignerSecret(): Promise<string | null> {
  return getSecureItem(await key(SecureKey.signerSecret));
}

export async function setSignerSecret(secret: string): Promise<void> {
  return setSecureItem(await key(SecureKey.signerSecret), secret);
}

/**
 * The SDK's own AsyncStorage keys, namespaced the same way by the adapter in
 * components/WalletProvider.tsx. They have to be cleared alongside the secure
 * store, or a reset leaves the SDK still holding a credential id — which it
 * then passes as excludeCredentials on the next registration, and the platform
 * refuses with "one of the excluded credentials exists on the local device".
 * The result was a wallet that could be reset but never re-created.
 */
export const SDK_KEYS = [
  'invisible_wallet_key_id',
  'invisible_wallet_public_key',
  'invisible_wallet_address',
  'invisible_wallet_user_id',
] as const;

/**
 * Secure-store keys backing the WalletProvider's persisted signer session.
 *
 * Deliberately NOT network-namespaced (see components/WalletProvider.tsx): the
 * session is the currently-unlocked wallet, whichever network that is. A reset
 * therefore clears them unconditionally.
 */
export const WALLET_SESSION_ADDRESS_KEY = 'veil_wallet_session_address';
export const WALLET_SESSION_SIGNER_SECRET_KEY = 'veil_wallet_session_signer_secret';
export const SESSION_KEYS = [
  WALLET_SESSION_ADDRESS_KEY,
  WALLET_SESSION_SIGNER_SECRET_KEY,
] as const;

/**
 * Cached, wallet-derived AsyncStorage state.
 *
 * None of these are wallet identity, but all of them describe a wallet that is
 * about to cease to exist: a queued spend, apps still connected to it, its
 * multisig contract, a pending recovery, its seen-notifications watermark and
 * its non-secret settings. Left behind, they make a "reset" wallet that still
 * believes it has an outbox, sessions or a contract — the half-reset the danger
 * screen exists to prevent. These keys are not network-namespaced in the rest of
 * the app, so they are removed unsuffixed.
 */
export const WALLET_CACHE_KEYS = [
  'veil_outbox_v1',
  'veil_walletconnect_sessions',
  'veil_multisig_contract',
  'veil_notified_movements',
  'veil_wallet_settings',
  'veil_pending_recovery_v1',
] as const;

/** Wipe the ACTIVE NETWORK's stored wallet identifiers only. */
export async function clearWalletStore(): Promise<void> {
  const suffix = getNetworkName() === 'mainnet' ? '_mainnet' : '';
  await Promise.all([
    key(SecureKey.walletAddress).then(deleteSecureItem),
    key(SecureKey.passkeyId).then(deleteSecureItem),
    key(SecureKey.passkeyPublicKey).then(deleteSecureItem),
    key(SecureKey.signerSecret).then(deleteSecureItem),
    ...SDK_KEYS.map((k) => AsyncStorage.removeItem(`${k}${suffix}`)),
  ]);
}

/**
 * Full wallet reset for the ACTIVE NETWORK.
 *
 * Composes {@link clearWalletStore} with the persisted signer session and every
 * piece of wallet-derived cached state, so the device is left with nothing that
 * can present itself as a partially-configured wallet. The OTHER network's
 * wallet is intentionally untouched — that is what the per-network namespacing
 * is for. Callers are responsible for routing back to onboarding afterwards.
 */
export async function resetWallet(): Promise<void> {
  await Promise.all([
    clearWalletStore(),
    Promise.all(SESSION_KEYS.map((k) => deleteSecureItem(k))),
    ...WALLET_CACHE_KEYS.map((k) => AsyncStorage.removeItem(k)),
  ]);
}
