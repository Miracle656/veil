import AsyncStorage from '@react-native-async-storage/async-storage';
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { getNetwork } from './network';
import { evaluatePrf } from './passkey';
import type { PrfOutcome } from './prfOutcome';
import { fundWithFriendbot } from './testnetWallet';
import { writeBreadcrumbs } from './walletBreadcrumbs';
import {
  getPasskeyPublicKey,
  getSignerSecret,
  getWalletAddress,
  setPasskeyCredential,
  setPasskeyId,
  setSignerSecret,
  setWalletAddress,
} from './walletStore';
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
  let issue: Exclude<PrfOutcome, 'ok'> = 'failed';
  if (keyId) {
    // The PRF output is what makes the wallet recoverable from the passkey
    // alone — retry once before giving up on it. Not after `unsupported`: the
    // passkey already answered without PRF, and asking again gets the same.
    for (let attempt = 0; attempt < 2 && !feePayer; attempt++) {
      const result = await evaluatePrf(keyId, FEE_PAYER_PRF_SALT);
      if (result.outcome === 'ok' && result.output) {
        feePayer = Keypair.fromRawEd25519Seed(Buffer.from(result.output.subarray(0, 32)));
      } else {
        issue = result.outcome === 'ok' ? 'unsupported' : result.outcome;
        if (issue === 'unsupported') break;
      }
    }
  }
  // Random fallback = the fee-payer CANNOT be re-derived from the passkey on
  // another device. Never do this silently: the caller surfaces `recoverable`.
  const recoverable = feePayer !== null;
  if (!feePayer) feePayer = Keypair.random();

  // Friendbot only exists on testnet; on mainnet this returns false at once.
  const funded = await fundWithFriendbot(feePayer.publicKey());

  // On-chain breadcrumbs (best-effort): make "sign in with passkey" work on a
  // fresh device by recording the C-address + passkey public key as data
  // entries on the (deterministic) fee-payer account.
  //
  // Deliberately NOT gated on the Friendbot result. That gate asked "did a
  // faucet just fund this?", and the answer on mainnet is always no, so every
  // mainnet wallet was created with no on-chain record of itself and no way to
  // be found again from a fresh device. The write needs a funded account, not a
  // faucet, and it already fails harmlessly when there is none — the account
  // simply does not load. `ensureBreadcrumbs` retries on dashboard load, which
  // is what covers the mainnet order of events: the account is funded after the
  // wallet is created, not before.
  void writeBreadcrumbs(feePayer.secret(), walletAddress, publicKeyBytes ?? null).catch(() => undefined);

  await Promise.all([
    setWalletAddress(walletAddress),
    setSignerSecret(feePayer.secret()),
    keyId && publicKeyBytes
      ? setPasskeyCredential(keyId, toHex(publicKeyBytes))
      : keyId
        ? setPasskeyId(keyId)
        : Promise.resolve(),
  ]);

  return { address: walletAddress, funded, recoverable, ...(recoverable ? {} : { recoveryIssue: issue }) };
}

async function accountExists(address: string): Promise<boolean> {
  try {
    await new Horizon.Server(getNetwork().horizonUrl).loadAccount(address);
    return true;
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    // Only a definite 404 means "not on chain". Anything else is unknown, and
    // unknown must count as existing, since the answer decides whether a key
    // that may control money gets replaced.
    return !(status === 404 || (err instanceof Error && err.name === 'NotFoundError'));
  }
}

export type RecoveryRetry =
  | { bound: true }
  | { bound: false; issue: Exclude<PrfOutcome, 'ok'> | 'funded' };

export type Recreation = { ok: true; wallet: CreatedWallet } | { ok: false; reason: 'funded' };

/**
 * Build the wallet again from a fresh passkey.
 *
 * Some password managers never implement the WebAuthn PRF extension, and no
 * amount of retrying one of *their* passkeys will produce a PRF output —
 * {@link retryRecoveryBinding} asks the same authenticator the same question
 * and gets the same answer. The only thing that changes the answer is a passkey
 * held somewhere else, and the platform asks where to save each new one. So
 * re-registering is the fix, and it keeps the user inside the app instead of
 * sending them into device settings to delete a credential by hand.
 *
 * This replaces the wallet rather than repairing it: the address is derived
 * from the passkey's public key, so a different passkey is a different wallet.
 * That is only safe while the old one is empty, which is why this is offered on
 * the creation screen and nowhere else, and why an on-chain spending account
 * refuses instead.
 */
export async function recreatePasskeyWallet(wallet: Registerable): Promise<Recreation> {
  const previous = await getSignerSecret();
  // Friendbot funds every wallet moments after it is made, so "the account
  // exists" says nothing on testnet about whether it holds anything worth
  // keeping. On a network with no faucet, it does.
  if (previous && !getNetwork().friendbotUrl) {
    if (await accountExists(Keypair.fromSecret(previous).publicKey())) return { ok: false, reason: 'funded' };
  }
  return { ok: true, wallet: await createPasskeyWallet(wallet) };
}

/**
 * Try again to bind the recovery secret to a freshly created wallet.
 *
 * When PRF failed at creation, the spending account got a random key, which no
 * other device can re-derive. If PRF works now, that key is replaced with the
 * passkey-derived one, so recovery works as designed.
 *
 * Only while the random account is not on chain. Once it exists it may hold
 * XLM or trustlines, and swapping its key would strand them; that case refuses
 * with `funded` and changes nothing. The smart wallet's own address never
 * changes, because it comes from the passkey's public key, not this key.
 */
export async function retryRecoveryBinding(): Promise<RecoveryRetry> {
  const keyId = await AsyncStorage.getItem(SDK_KEY_ID);
  const walletAddress = await getWalletAddress();
  if (!keyId || !walletAddress) return { bound: false, issue: 'failed' };

  const result = await evaluatePrf(keyId, FEE_PAYER_PRF_SALT);
  if (result.outcome !== 'ok' || !result.output) {
    return { bound: false, issue: result.outcome === 'ok' ? 'unsupported' : result.outcome };
  }
  const derived = Keypair.fromRawEd25519Seed(Buffer.from(result.output.subarray(0, 32)));

  const currentSecret = await getSignerSecret();
  if (currentSecret && currentSecret !== derived.secret()) {
    if (await accountExists(Keypair.fromSecret(currentSecret).publicKey())) {
      return { bound: false, issue: 'funded' };
    }
  }

  await setSignerSecret(derived.secret());
  const pubHex = await getPasskeyPublicKey().catch(() => null);
  const pub = pubHex && /^[0-9a-fA-F]{130}$/.test(pubHex) ? new Uint8Array(Buffer.from(pubHex, 'hex')) : null;
  void writeBreadcrumbs(derived.secret(), walletAddress, pub).catch(() => undefined);
  return { bound: true };
}
