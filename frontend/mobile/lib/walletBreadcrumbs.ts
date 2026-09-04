/**
 * On-chain wallet breadcrumbs — the serverless recovery index.
 *
 * The PRF fee-payer G-account is deterministically derived from the passkey, so
 * anyone holding the passkey can re-derive it on any device. What they can't
 * re-derive is the smart wallet's C-address (a function of the passkey's PUBLIC
 * key, which WebAuthn assertions never reveal). So at creation we write the
 * missing facts as manage-data entries ON the fee-payer account:
 *
 *   veil:wallet — the C-address (56 ASCII chars, fits one 64-byte entry)
 *   veil:pk1    — passkey public key bytes 1..32  (after the 0x04 prefix)
 *   veil:pk2    — passkey public key bytes 33..64
 *
 * Login on a fresh device: passkey → PRF → fee-payer keypair → Horizon data
 * entries → full wallet. No backend, no seed phrase.
 */

import { BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { getNetwork } from './network';
import { inclusionFee } from './fees';

export const CRUMB_WALLET = 'veil:wallet';
export const CRUMB_PK1 = 'veil:pk1';
export const CRUMB_PK2 = 'veil:pk2';

export type Breadcrumbs = {
  walletAddress: string;
  /** Uncompressed P-256 public key (65 bytes, 0x04-prefixed), when recorded. */
  publicKeyBytes: Uint8Array | null;
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
    }).addOperation(Operation.manageData({ name: CRUMB_WALLET, value: walletAddress }));

    if (publicKeyBytes && publicKeyBytes.length === 65 && publicKeyBytes[0] === 0x04) {
      builder
        .addOperation(Operation.manageData({ name: CRUMB_PK1, value: Buffer.from(publicKeyBytes.subarray(1, 33)) }))
        .addOperation(Operation.manageData({ name: CRUMB_PK2, value: Buffer.from(publicKeyBytes.subarray(33, 65)) }));
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
    if (existing?.walletAddress === address && existing.publicKeyBytes) return; // already complete

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

    const walletB64 = data[CRUMB_WALLET];
    if (!walletB64) return null;
    const walletAddress = Buffer.from(walletB64, 'base64').toString('utf8');
    if (!walletAddress.startsWith('C') || walletAddress.length !== 56) return null;

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

    return { walletAddress, publicKeyBytes };
  } catch {
    return null;
  }
}
