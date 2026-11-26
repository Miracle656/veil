/**
 * On-chain wallet breadcrumbs — the serverless recovery index.
 *
 * The PRF fee-payer G-account is deterministically derived from the passkey, so
 * anyone holding the passkey can re-derive it on any device. What they cannot
 * re-derive is the passkey's PUBLIC key, which WebAuthn assertions never
 * reveal. So at creation we write it as manage-data entries ON the fee-payer
 * account:
 *
 *   veil:pk1    — passkey public key bytes 1..32  (after the 0x04 prefix)
 *   veil:pk2    — passkey public key bytes 33..64
 *
 * Login on a fresh device: passkey → PRF → fee-payer keypair → Horizon data
 * entries → full wallet. No backend, no seed phrase.
 *
 * The C-address is NOT stored, because it does not need to be. It is the
 * deployer-derived address of the factory salted with the hash of that public
 * key, so `computeWalletAddress` reconstructs it exactly from the two entries
 * above. It used to be written as a third entry, `veil:wallet`, which cost
 * every user a further 0.5 XLM of locked reserve to store a number the app can
 * compute. Accounts that still carry it are read from it and then have it
 * cleared, returning the reserve.
 *
 * Each entry locks 0.5 XLM of the fee payer's balance for as long as it exists.
 * That is refundable — deleting the entry releases it — but it is the user's
 * money held hostage by our own convenience, so the count matters.
 */

import { BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { computeWalletAddress } from '@veil/utils';

import { getNetwork } from './network';
import { inclusionFee } from './fees';

export const CRUMB_WALLET = 'veil:wallet';
export const CRUMB_PK1 = 'veil:pk1';
export const CRUMB_PK2 = 'veil:pk2';

export type Breadcrumbs = {
  walletAddress: string;
  /** Uncompressed P-256 public key (65 bytes, 0x04-prefixed), when recorded. */
  publicKeyBytes: Uint8Array | null;
  /**
   * Whether the account still carries the retired `veil:wallet` entry, which is
   * 0.5 XLM of the user's reserve spent on a derivable value. Drives the
   * one-off cleanup in {@link ensureBreadcrumbs}.
   */
  hasLegacyWalletEntry: boolean;
};

/**
 * Write the breadcrumbs. The fee-payer signs and pays; requires the account to
 * be funded. Idempotent — manage-data overwrites. Best-effort by design: a
 * failure must never block wallet creation, so callers treat `false` as
 * "breadcrumbs pending" (they can be re-written later).
 */
export async function writeBreadcrumbs(
  feePayerSecret: string,
  walletAddress: string,
  publicKeyBytes: Uint8Array | null,
): Promise<boolean> {
  try {
    const net = getNetwork();
    const server = new Horizon.Server(net.horizonUrl);
    const kp = Keypair.fromSecret(feePayerSecret);
    const account = await server.loadAccount(kp.publicKey());

    const builder = new TransactionBuilder(account, {
      fee: inclusionFee(),
      networkPassphrase: net.networkPassphrase,
    });

    const haveKey = !!publicKeyBytes && publicKeyBytes.length === 65 && publicKeyBytes[0] === 0x04;

    if (haveKey) {
      const key = publicKeyBytes as Uint8Array;
      builder
        .addOperation(Operation.manageData({ name: CRUMB_PK1, value: Buffer.from(key.subarray(1, 33)) }))
        .addOperation(Operation.manageData({ name: CRUMB_PK2, value: Buffer.from(key.subarray(33, 65)) }));

      // The address derives from the key, so storing it too costs 0.5 XLM of
      // the user's reserve for nothing. A null value deletes the entry, which
      // returns that reserve on accounts written by an earlier build.
      if (account.data_attr && CRUMB_WALLET in account.data_attr) {
        builder.addOperation(Operation.manageData({ name: CRUMB_WALLET, value: null }));
      }
    } else {
      // No public key to hand — the address is then the only record there is,
      // and is worth its 0.5 XLM until a later write supplies the key.
      builder.addOperation(Operation.manageData({ name: CRUMB_WALLET, value: walletAddress }));
    }

    const tx = builder.setTimeout(30).build();
    tx.sign(kp);
    await server.submitTransaction(tx);
    return true;
  } catch {
    return false;
  }
}

/**
 * Self-heal: wallets created before breadcrumbs existed have no on-chain
 * record, so "sign in with passkey" can't find them from a fresh device. Any
 * device that still HOLDS the wallet has everything needed to write the record
 * retroactively — run this on dashboard load (idempotent, at most one write,
 * throttled to one attempt per app session).
 */
let healAttempted = false;
export async function ensureBreadcrumbs(): Promise<void> {
  if (healAttempted) return;
  healAttempted = true;
  try {
    const [{ getWalletAddress, getSignerSecret, getPasskeyPublicKey }, AsyncStorage] = await Promise.all([
      import('./walletStore'),
      import('@react-native-async-storage/async-storage').then((m) => m.default),
    ]);
    const [address, secret] = await Promise.all([getWalletAddress(), getSignerSecret()]);
    if (!address || !secret || !address.startsWith('C')) return;

    const feePayer = Keypair.fromSecret(secret);
    const existing = await readBreadcrumbs(feePayer.publicKey());
    // Complete AND tidy. The legacy check matters: once the key entries exist
    // the address derives from them, so without it this would return early and
    // leave the retired entry — and its 0.5 XLM — in place forever.
    if (existing?.walletAddress === address && existing.publicKeyBytes && !existing.hasLegacyWalletEntry) {
      return;
    }

    // Public key: prefer the secure store's mirror, fall back to the SDK's copy.
    const pkHex =
      (await getPasskeyPublicKey().catch(() => null)) ||
      (await AsyncStorage.getItem('invisible_wallet_public_key').catch(() => null));
    const pkBytes = pkHex && /^[0-9a-fA-F]{130}$/.test(pkHex) ? new Uint8Array(Buffer.from(pkHex, 'hex')) : null;

    await writeBreadcrumbs(secret, address, pkBytes);
  } catch {
    // best-effort — never disturb the dashboard
  }
}

/** Read the breadcrumbs from a fee-payer account. Null when none are present. */
export async function readBreadcrumbs(feePayerAddress: string): Promise<Breadcrumbs | null> {
  try {
    const net = getNetwork();
    const server = new Horizon.Server(net.horizonUrl);
    const account = await server.loadAccount(feePayerAddress);
    const data = account.data_attr as Record<string, string>; // base64 values

    let publicKeyBytes: Uint8Array | null = null;
    const pk1 = data[CRUMB_PK1];
    const pk2 = data[CRUMB_PK2];
    if (pk1 && pk2) {
      const b1 = Buffer.from(pk1, 'base64');
      const b2 = Buffer.from(pk2, 'base64');
      if (b1.length === 32 && b2.length === 32) {
        publicKeyBytes = new Uint8Array(65);
        publicKeyBytes[0] = 0x04;
        publicKeyBytes.set(b1, 1);
        publicKeyBytes.set(b2, 33);
      }
    }

    // Prefer deriving. The key is the authority: a stored address could only
    // ever agree with it, and accounts written by newer builds have no stored
    // address at all.
    if (publicKeyBytes) {
      return {
        walletAddress: computeWalletAddress(net.factoryContractId, publicKeyBytes, net.networkPassphrase),
        publicKeyBytes,
        hasLegacyWalletEntry: CRUMB_WALLET in data,
      };
    }

    // No key: fall back to the address recorded by an older build.
    const walletB64 = data[CRUMB_WALLET];
    if (!walletB64) return null;
    const walletAddress = Buffer.from(walletB64, 'base64').toString('utf8');
    if (!walletAddress.startsWith('C') || walletAddress.length !== 56) return null;

    return { walletAddress, publicKeyBytes: null, hasLegacyWalletEntry: true };
  } catch {
    return null;
  }
}
