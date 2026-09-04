import AsyncStorage from '@react-native-async-storage/async-storage';
import { Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { nativePrfEvaluator } from './passkey';
import { fundWithFriendbot } from './testnetWallet';
import { writeBreadcrumbs } from './walletBreadcrumbs';
import { setWalletAddress, setSignerSecret, setPasskeyId, setPasskeyCredential } from './walletStore';
import type { CreatedWallet } from './testnetWallet';

/**
 * Domain-separated PRF salt for the fee-payer key. Matches the SDK's
 * `FEE_PAYER_PRF_SALT` so the passkey → fee-payer mapping is stable.
 */
const FEE_PAYER_PRF_SALT = new Uint8Array(new TextEncoder().encode('invisible-wallet/prf/feepayer/v1'));

/** SDK storage key holding the WebAuthn credential id (see useInvisibleWallet). */
const SDK_KEY_ID = 'invisible_wallet_key_id';

/** Minimal shape of the SDK's register(); avoids importing the whole hook type. */
type Registerable = {
  register: (username?: string) => Promise<{ walletAddress: string; publicKeyBytes?: Uint8Array }>;
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a passkey smart wallet (dev build only — needs the native passkey
 * module + a domain-associated RP):
 *
 *   1. `register()` creates a WebAuthn P-256 credential and computes the
 *      deterministic C-address wallet (via the factory).
 *   2. Derive the fee-payer G-account from the passkey's WebAuthn PRF output —
 *      deterministic, so it's recoverable from the same passkey. Falls back to a
 *      random keypair when PRF is unavailable (non-recoverable that session).
 *   3. Fund the fee-payer with Friendbot (it sponsors the C-wallet's fees;
 *      Friendbot only funds classic G-accounts).
 *   4. Persist to the app's secure store so the rest of the app recognises it.
 *
 * NOTE: transacting *from* the C-wallet (send/swap) uses the smart-wallet
 * signing path (passkey __check_auth), not the keypair path used in testnet
 * mode — that's a separate milestone.
 */
export async function createPasskeyWallet(wallet: Registerable): Promise<CreatedWallet> {
  const { walletAddress, publicKeyBytes } = await wallet.register('Veil wallet');

  const keyId = await AsyncStorage.getItem(SDK_KEY_ID);
  let feePayer: Keypair | null = null;
  if (keyId) {
    // The PRF output is what makes the wallet recoverable from the passkey
    // alone — retry once before giving up on it.
    for (let attempt = 0; attempt < 2 && !feePayer; attempt++) {
      const prf = await nativePrfEvaluator(keyId)(FEE_PAYER_PRF_SALT).catch(() => null);
      if (prf && prf.length >= 32) {
        feePayer = Keypair.fromRawEd25519Seed(Buffer.from(prf.subarray(0, 32)));
      }
    }
  }
  // Random fallback = the fee-payer CANNOT be re-derived from the passkey on
  // another device. Never do this silently: the caller surfaces `recoverable`.
  const recoverable = feePayer !== null;
  if (!feePayer) feePayer = Keypair.random();

  const funded = await fundWithFriendbot(feePayer.publicKey());

  // On-chain breadcrumbs (best-effort): make "sign in with passkey" work on a
  // fresh device by recording the C-address + passkey public key as data
  // entries on the (deterministic) fee-payer account. Needs funding first.
  if (funded) {
    void writeBreadcrumbs(feePayer.secret(), walletAddress, publicKeyBytes ?? null).catch(() => undefined);
  }

  await Promise.all([
    setWalletAddress(walletAddress),
    setSignerSecret(feePayer.secret()),
    keyId && publicKeyBytes
      ? setPasskeyCredential(keyId, toHex(publicKeyBytes))
      : keyId
        ? setPasskeyId(keyId)
        : Promise.resolve(),
  ]);

  return { address: walletAddress, funded, recoverable };
}
