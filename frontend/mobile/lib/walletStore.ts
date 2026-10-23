import AsyncStorage from '@react-native-async-storage/async-storage';

import { SecureKey, getSecureItem, setSecureItem, deleteSecureItem } from './storage';
import { getNetworkName, hydrateNetwork } from './network';
import { clearSppDatabase } from './privacy/storage';
// Wallet-derived AsyncStorage keys, imported from the module that owns each one
// rather than repeated as string literals. A rename is then a single edit, and
// leaving a key out of walletCacheKeys() has to be an explicit decision — the
// reset test fails until the list matches the owners.
import { OUTBOX_STORAGE_KEY } from './outbox';
import { WALLETCONNECT_SESSIONS_KEY } from './walletConnect';
import { MULTISIG_CONTRACT_STORAGE_KEY } from './multisig';
import { NOTIFIED_MOVEMENTS_KEY } from './notifiedMovements';
import { WALLET_SETTINGS_STORAGE_KEY, BACKUP_LAST_EXPORTED_KEY } from './backupFile';
import { PENDING_RECOVERY_KEY, RECOVERY_SERVERS_KEY } from './recovery';
import { ORIGIN_PERMISSIONS_STORAGE_KEY } from './permissions';
import { OFFRAMP_ACTIVE_ORDER_KEY, OFFRAMP_DEPOSIT_ADDRESSES_KEY } from './offramp';
import { FEE_PAYER_SOURCE_KEY } from './feePayerSource';

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
 * about to cease to exist: a queued spend, apps still connected to it (both
 * WalletConnect sessions and per-origin dApp grants), its multisig contract, a
 * pending recovery and the server list it was configured with, its
 * seen-notifications watermark, its non-secret settings, the last backup it
 * exported, an in-flight cash-out with the deposit addresses it has used, and
 * how its fee payer was derived. Left behind, they make a "reset" wallet that
 * still believes it has an outbox, connections or a contract — or, worse, one
 * that reports a backup date belonging to a wallet that no longer exists. That
 * is the half-reset the danger screen exists to prevent.
 *
 * The names are imported from the module that owns each key, never repeated as
 * string literals, so a rename is one edit and a forgotten wallet-derived key
 * has to be an explicit decision rather than an oversight.
 *
 * Most are removed unsuffixed, because they do not carry a per-network suffix
 * in the rest of the app. The few that do are listed in
 * {@link networkScopedWalletCacheKeys} and removed with the active network's
 * suffix, so a reset never reaches the other network's copy.
 *
 * Returned from a function rather than held in a module-level array, and this is
 * load-bearing: `walletConnect`, `recovery` and `feePayerSource` all import from
 * `walletStore`, so importing their key constants here closes an import cycle.
 * Whenever one of those modules is the one that enters the cycle, its body has
 * not run yet at the moment this module is evaluated, and a module-level array
 * captures `undefined` for its keys -- `resetWallet` then deleted the literal
 * key `"undefined"` and left `veil_fee_payer_source` on the device. Reading the
 * constants inside a function defers them to call time, by which point every
 * module is fully initialised whichever one was entered first.
 */
export function walletCacheKeys(): readonly string[] {
  return [
    OUTBOX_STORAGE_KEY,
    WALLETCONNECT_SESSIONS_KEY,
    MULTISIG_CONTRACT_STORAGE_KEY,
    NOTIFIED_MOVEMENTS_KEY,
    WALLET_SETTINGS_STORAGE_KEY,
    PENDING_RECOVERY_KEY,
    ORIGIN_PERMISSIONS_STORAGE_KEY,
    BACKUP_LAST_EXPORTED_KEY,
    OFFRAMP_ACTIVE_ORDER_KEY,
    OFFRAMP_DEPOSIT_ADDRESSES_KEY,
    FEE_PAYER_SOURCE_KEY,
    RECOVERY_SERVERS_KEY,
  ];
}

/**
 * Of {@link walletCacheKeys}, the keys whose owner namespaces them per network.
 * {@link resetWallet} removes the ACTIVE network's variant of each, so clearing
 * one network's wallet never takes the other network's state with it. Deferred
 * to call time for the same import-cycle reason as {@link walletCacheKeys}.
 */
export function networkScopedWalletCacheKeys(): ReadonlySet<string> {
  return new Set([FEE_PAYER_SOURCE_KEY]);
}

/** Wipe the ACTIVE NETWORK's stored wallet identifiers only. */
export async function clearWalletStore(): Promise<void> {
  const walletAddress = await getWalletAddress();
  const suffix = getNetworkName() === 'mainnet' ? '_mainnet' : '';

  await Promise.all([
    key(SecureKey.walletAddress).then(deleteSecureItem),
    key(SecureKey.passkeyId).then(deleteSecureItem),
    key(SecureKey.passkeyPublicKey).then(deleteSecureItem),
    key(SecureKey.signerSecret).then(deleteSecureItem),
    ...SDK_KEYS.map((k) => AsyncStorage.removeItem(`${k}${suffix}`)),
    // Clear SPP state when the wallet is removed.
    walletAddress ? clearSppDatabase(walletAddress) : Promise.resolve(),
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
  // Network-scoped cache keys (the fee-payer provenance record) are stored
  // under the active network's suffix, so the unsuffixed removal below would
  // miss the one on a mainnet reset. Missing it left the next mainnet wallet
  // labelled with the fee-payer provenance of the wallet that was just reset.
  const suffix = getNetworkName() === 'mainnet' ? '_mainnet' : '';
  const networkScoped = networkScopedWalletCacheKeys();
  await Promise.all([
    clearWalletStore(),
    Promise.all(SESSION_KEYS.map((k) => deleteSecureItem(k))),
    ...walletCacheKeys().map((k) =>
      networkScoped.has(k)
        ? AsyncStorage.removeItem(`${k}${suffix}`)
        : AsyncStorage.removeItem(k)
    ),
  ]);
}
