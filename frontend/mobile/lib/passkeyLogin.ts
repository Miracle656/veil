import AsyncStorage from '@react-native-async-storage/async-storage';
import { Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { discoverWithPrf, nativePrfEvaluator } from './passkey';
import { readBreadcrumbs, writeBreadcrumbs } from './walletBreadcrumbs';
import { getSignerSecret, getWalletAddress, setPasskeyCredential, setPasskeyId, setSignerSecret, setWalletAddress } from './walletStore';

/** Same PRF salt the fee-payer was derived with at creation (SDK constant). */
const FEE_PAYER_PRF_SALT = new Uint8Array(new TextEncoder().encode('invisible-wallet/prf/feepayer/v1'));

// SDK storage keys — mirrored so the SDK's login()/signAuthEntry() see the
// recovered wallet exactly as if register() had run on this device.
const SDK_ADDRESS = 'invisible_wallet_address';
const SDK_KEY_ID = 'invisible_wallet_key_id';
const SDK_PUBLIC_KEY = 'invisible_wallet_public_key';

export type LoginResult = {
  address: string;
  /** 'local' = wallet was already on this device; 'recovered' = rebuilt from the passkey. */
  source: 'local' | 'recovered';
};

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Sign in with an existing passkey.
 *
 * Same device (wallet still in secure storage): verify it's intact and return —
 * no stress, no prompts beyond what the caller chooses to gate with.
 *
 * Fresh install / new phone (passkey synced via Google Password Manager or
 * iCloud Keychain): one discoverable passkey prompt returns the credential and
 * its PRF output → the deterministic fee-payer keypair → the on-chain
 * breadcrumbs on that account name the C-address and passkey public key →
 * everything is re-persisted locally. Serverless, seedless.
 */
export async function loginWithPasskey(): Promise<LoginResult> {
  // ── Same-device fast path ──────────────────────────────────────────────────
  const [storedAddress, storedSecret] = await Promise.all([
    getWalletAddress().catch(() => null),
    getSignerSecret().catch(() => null),
  ]);
  if (storedAddress && storedSecret) {
    return { address: storedAddress, source: 'local' };
  }

  // ── Same-device, secure store cleared (e.g. "Reset wallet") ───────────────
  // The SDK's AsyncStorage copy survives a secure-store reset. One PRF prompt
  // against the recorded credential re-derives the fee-payer; the address and
  // public key come straight from that copy — no breadcrumbs required. Write
  // the breadcrumbs afterwards so a genuinely fresh device works next time.
  const [sdkAddress, sdkKeyId, sdkPubKey] = await Promise.all([
    AsyncStorage.getItem(SDK_ADDRESS).catch(() => null),
    AsyncStorage.getItem(SDK_KEY_ID).catch(() => null),
    AsyncStorage.getItem(SDK_PUBLIC_KEY).catch(() => null),
  ]);
  if (sdkAddress && sdkKeyId) {
    const prf = await nativePrfEvaluator(sdkKeyId)(FEE_PAYER_PRF_SALT);
    if (prf && prf.length >= 32) {
      const feePayer = Keypair.fromRawEd25519Seed(Buffer.from(prf.subarray(0, 32)));
      await Promise.all([
        setWalletAddress(sdkAddress),
        setSignerSecret(feePayer.secret()),
        sdkPubKey ? setPasskeyCredential(sdkKeyId, sdkPubKey) : setPasskeyId(sdkKeyId),
      ]);
      const pkBytes = sdkPubKey && /^[0-9a-fA-F]{130}$/.test(sdkPubKey) ? new Uint8Array(Buffer.from(sdkPubKey, 'hex')) : null;
      void writeBreadcrumbs(feePayer.secret(), sdkAddress, pkBytes).catch(() => undefined);
      return { address: sdkAddress, source: 'recovered' };
    }
    // PRF unavailable / cancelled — fall through to the discoverable flow,
    // which reports its own clearer errors.
  }

  // ── Fresh-device recovery ──────────────────────────────────────────────────
  const picked = await discoverWithPrf(FEE_PAYER_PRF_SALT);
  if (!picked) throw new Error('Passkey sign-in was cancelled.');
  if (!picked.prf || picked.prf.length < 32) {
    throw new Error(
      "This passkey didn't return a PRF secret, so the wallet can't be re-derived from it on this device. " +
        'Use the recovery-server flow instead.',
    );
  }

  const feePayer = Keypair.fromRawEd25519Seed(Buffer.from(picked.prf.subarray(0, 32)));
  const crumbs = await readBreadcrumbs(feePayer.publicKey());
  if (!crumbs) {
    throw new Error(
      'No wallet is linked to this passkey on this network. Wallets created before sign-in support ' +
        'publish their record the next time their home screen opens on the device that holds them — ' +
        'open the wallet there once, then sign in here.',
    );
  }

  // Persist to the app's secure store…
  await Promise.all([
    setWalletAddress(crumbs.walletAddress),
    setSignerSecret(feePayer.secret()),
    crumbs.publicKeyBytes
      ? setPasskeyCredential(picked.credentialId, toHex(crumbs.publicKeyBytes))
      : setPasskeyId(picked.credentialId),
  ]);

  // …and mirror the SDK's storage so its login()/signAuthEntry() work too.
  const sdkWrites: Array<[string, string]> = [
    [SDK_ADDRESS, crumbs.walletAddress],
    [SDK_KEY_ID, picked.credentialId],
  ];
  if (crumbs.publicKeyBytes) sdkWrites.push([SDK_PUBLIC_KEY, toHex(crumbs.publicKeyBytes)]);
  await AsyncStorage.multiSet(sdkWrites);

  return { address: crumbs.walletAddress, source: 'recovered' };
}
