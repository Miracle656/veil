import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';

import { computeWalletAddress } from '../../../sdk/src/utils';
import { getNetwork } from './network';
import { getPasskeyPublicKey, getSignerSecret, getWalletAddress, setWalletAddress } from './walletStore';
import { writeBreadcrumbs } from './walletBreadcrumbs';

/**
 * One-shot repair for wallets whose C-address was derived with the WRONG
 * network parameters: the SDK's config used to freeze to testnet before the
 * network override hydrated, so a mainnet registration computed its address
 * from the testnet factory + passphrase. The passkey and fee-payer are fine —
 * only the address label is wrong — so recompute it from the stored passkey
 * public key against the LIVE factory/passphrase and re-persist everywhere.
 *
 * Returns the correct address (repaired or already-correct), or null when the
 * wallet/pubkey isn't available.
 */
let repairAttempted = false;
export async function ensureCorrectWalletAddress(): Promise<string | null> {
  const stored = await getWalletAddress().catch(() => null);
  if (!stored || !stored.startsWith('C')) return stored;
  if (repairAttempted) return stored;
  repairAttempted = true;

  try {
    const pkHex =
      (await getPasskeyPublicKey().catch(() => null)) ||
      (await AsyncStorage.getItem('invisible_wallet_public_key').catch(() => null));
    if (!pkHex || !/^[0-9a-fA-F]{130}$/.test(pkHex)) return stored;

    const net = getNetwork();
    if (!net.factoryContractId) return stored;
    const correct = computeWalletAddress(net.factoryContractId, new Uint8Array(Buffer.from(pkHex, 'hex')), net.networkPassphrase);
    if (correct === stored) return stored;

    // Re-persist: secure store, the SDK's AsyncStorage mirror, and the
    // on-chain breadcrumbs (so sign-in finds the corrected address).
    await setWalletAddress(correct);
    await AsyncStorage.setItem('invisible_wallet_address', correct).catch(() => undefined);
    const secret = await getSignerSecret().catch(() => null);
    if (secret) {
      void writeBreadcrumbs(secret, correct, new Uint8Array(Buffer.from(pkHex, 'hex'))).catch(() => undefined);
    }
    console.warn(`[walletRepair] corrected wallet address ${stored.slice(0, 8)}… → ${correct.slice(0, 8)}…`);
    return correct;
  } catch {
    return stored;
  }
}
