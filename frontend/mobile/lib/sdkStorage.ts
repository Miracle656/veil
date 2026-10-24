/**
 * The SDK's AsyncStorage keys, read and written the way the SDK actually stores
 * them.
 *
 * `components/WalletProvider.tsx` hands the SDK a StorageAdapter that namespaces
 * every key per network — testnet keeps the bare name, mainnet takes a
 * `_mainnet` suffix — for the same reason `walletStore` does: one device holds
 * two wallets, and sharing one set of keys between them meant registering on one
 * network passed the other network's credential as `excludeCredentials`, and a
 * reset on testnet did not reset mainnet.
 *
 * The adapter was added; the modules that reach past the SDK into AsyncStorage
 * directly were not updated with it. On mainnet each of them read a key the SDK
 * never writes, got null, and took its "nothing stored" branch:
 *
 *   • `createPasskeyWallet` found no credential id, so it skipped PRF entirely
 *     (random fee-payer, wallet not recoverable from the passkey) and never
 *     wrote the public key to the secure store.
 *   • `ensureBreadcrumbs` then found no public key in either place, so it
 *     recorded `veil:wallet` alone — which is exactly what every recently
 *     created mainnet fee-payer carries on chain, and why those wallets cannot
 *     be deployed or spent from.
 *   • `retryRecoveryBinding` returned `failed`, so the recovery screen said
 *     "Could not check this passkey. Try again." to a user for whom trying
 *     again could never work.
 *   • The encrypted backup recorded an empty address and no public key, making
 *     a mainnet backup unable to restore the wallet it was taken from.
 *
 * One helper, so a module cannot drift from the adapter again.
 *
 * There is deliberately NO fallback to the bare key on mainnet. On testnet the
 * bare keys ARE the testnet wallet, so falling back would hand a mainnet caller
 * a testnet credential — binding the wrong wallet, which is worse than finding
 * nothing.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getNetworkName, hydrateNetwork } from './network';

/** Credential id of the registered passkey, as the SDK names it. */
export const SDK_ADDRESS = 'invisible_wallet_address';
export const SDK_KEY_ID = 'invisible_wallet_key_id';
export const SDK_PUBLIC_KEY = 'invisible_wallet_public_key';

/**
 * `base` under the active network's namespace.
 *
 * Hydration is awaited first for the same reason `walletStore.key()` does it: a
 * cold start that reads before the persisted network override lands would
 * resolve to the wrong network's keys.
 */
export async function sdkStorageKey(base: string): Promise<string> {
  await hydrateNetwork();
  return getNetworkName() === 'mainnet' ? `${base}_mainnet` : base;
}

/** Read one SDK value for the active network. Null when absent or unreadable. */
export async function getSdkItem(base: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(await sdkStorageKey(base));
  } catch {
    return null;
  }
}

/** Write SDK values for the active network, given `[base, value]` pairs. */
export async function setSdkItems(entries: readonly (readonly [string, string])[]): Promise<void> {
  const scoped = await Promise.all(
    entries.map(async ([base, value]) => [await sdkStorageKey(base), value] as [string, string]),
  );
  await AsyncStorage.multiSet(scoped);
}
