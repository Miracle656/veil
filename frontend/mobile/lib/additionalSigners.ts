/**
 * The passkeys this device knows about BEYOND the wallet's primary one.
 *
 * The primary binding — wallet address, credential id, public key, fee payer —
 * lives under the four primary keys in walletStore, and everything on the
 * device derives from it: the fee payer from the primary credential's PRF, the
 * address from its public key, every spend's signature from its id. Writing any
 * of them repoints the device at a different wallet. That is how the first
 * "Add a passkey" button (which called the SDK's register()) would have
 * stranded funds.
 *
 * So additional signers get their own secure-store key, their own versioned
 * record (the SDK's format, shared with the web wallet), and a writer that goes
 * through the SDK's `guardPrimaryBinding`: an attempt to touch a primary key
 * from here throws instead of rebinding the wallet. This module imports no
 * walletStore setter, and a test keeps it that way.
 */

import {
  forgetAdditionalSigner,
  guardPrimaryBinding,
  readAdditionalSigners,
  saveAdditionalSigner,
  type AdditionalSigner,
  type StorageAdapter,
} from '@veil/sdk';

import { getNetworkName, hydrateNetwork } from './network';
import { deleteSecureItem, getSecureItem, setSecureItem } from './storage';
import { getPasskeyId, getPasskeyPublicKey } from './walletStore';

export type { AdditionalSigner };

/**
 * A secure-store adapter in the SDK's StorageAdapter shape, namespaced per
 * network exactly as walletStore namespaces the primary keys (testnet bare,
 * mainnet `_mainnet`), and wrapped in the primary-binding guard.
 */
function signerStore(): StorageAdapter {
  const scoped = async (key: string) => {
    await hydrateNetwork();
    return getNetworkName() === 'mainnet' ? `${key}_mainnet` : key;
  };
  return guardPrimaryBinding({
    getItem: async (key) => getSecureItem(await scoped(key)),
    setItem: async (key, value) => setSecureItem(await scoped(key), value),
    removeItem: async (key) => deleteSecureItem(await scoped(key)),
  });
}

async function primary(): Promise<{ credentialId: string | null; publicKey: string | null }> {
  const [credentialId, publicKey] = await Promise.all([getPasskeyId(), getPasskeyPublicKey()]);
  return { credentialId, publicKey };
}

/** Every additional signer saved for the active network's wallet. */
export function listAdditionalSigners(): Promise<AdditionalSigner[]> {
  return readAdditionalSigners(signerStore());
}

/** Only the ones confirmed in the wallet's on-chain signer list. */
export async function listActiveAdditionalSigners(): Promise<AdditionalSigner[]> {
  return (await listAdditionalSigners()).filter((s) => s.status === 'active');
}

/** Insert or update one record. Refuses the primary credential. */
export async function recordAdditionalSigner(signer: AdditionalSigner): Promise<void> {
  await saveAdditionalSigner(signerStore(), signer, await primary());
}

/**
 * Drop a PENDING record. An active one is a signer on chain, and forgetting it
 * here would not remove it there — it would only hide a key that can still
 * spend — so that is refused.
 */
export async function forgetPendingSigner(credentialId: string): Promise<void> {
  const existing = (await listAdditionalSigners()).find((s) => s.credentialId === credentialId);
  if (existing?.status === 'active') {
    throw new Error('This passkey is a signer on the wallet. Forgetting it here would not remove it on chain.');
  }
  await forgetAdditionalSigner(signerStore(), credentialId);
}
