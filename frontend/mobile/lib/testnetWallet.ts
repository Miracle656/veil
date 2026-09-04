/**
 * Testnet wallet lifecycle — generate a Stellar keypair, fund it via Friendbot,
 * and persist it as the active wallet. This is the Expo-Go-friendly path that
 * lets every flow (send / swap / earn) run end-to-end on testnet without the
 * native passkey/smart-wallet stack.
 */

import { Keypair } from '@stellar/stellar-sdk';

import { getNetwork } from './network';
import { setSignerSecret, setWalletAddress, getWalletAddress, getSignerSecret } from './walletStore';

/** Fund an account with the network's Friendbot. Resolves true on success. */
export async function fundWithFriendbot(address: string): Promise<boolean> {
  const { friendbotUrl } = getNetwork();
  if (!friendbotUrl) return false; // mainnet has no faucet
  try {
    const res = await fetch(`${friendbotUrl}?addr=${encodeURIComponent(address)}`);
    if (res.ok) return true;
    if (res.status === 400) {
      // 400 covers BOTH "already funded" (fine) and "invalid request" (e.g. a
      // C-address, which Friendbot can't create). Only the former is a success.
      const body = await res.text().catch(() => '');
      return /already.*(fund|exist)|createAccountAlreadyExist/i.test(body);
    }
    return false;
  } catch {
    return false;
  }
}

export type CreatedWallet = {
  address: string;
  funded: boolean;
  /**
   * False when the fee-payer had to fall back to a random key (PRF unavailable)
   * — the wallet then cannot be re-derived from the passkey on another device.
   * Absent for plain keypair wallets, where the question doesn't apply.
   */
  recoverable?: boolean;
};

/**
 * Create a fresh testnet wallet: generate a keypair, persist it as the active
 * wallet, and fund it via Friendbot. The account is immediately usable — it can
 * receive, send, swap, and supply to Earn.
 */
export async function createTestnetWallet(): Promise<CreatedWallet> {
  const kp = Keypair.random();
  const address = kp.publicKey();
  await Promise.all([setSignerSecret(kp.secret()), setWalletAddress(address)]);
  const funded = await fundWithFriendbot(address);
  return { address, funded };
}

/**
 * Import an existing testnet wallet from a secret seed. Validates the seed,
 * persists it, and tops it up from Friendbot if the account isn't funded yet.
 */
export async function importTestnetWallet(secret: string): Promise<CreatedWallet> {
  const kp = Keypair.fromSecret(secret.trim()); // throws on a malformed seed
  const address = kp.publicKey();
  await Promise.all([setSignerSecret(kp.secret()), setWalletAddress(address)]);
  const funded = await fundWithFriendbot(address);
  return { address, funded };
}

/** Whether a signable wallet key is present on this device. */
export async function hasWalletKey(): Promise<boolean> {
  const [addr, secret] = await Promise.all([getWalletAddress(), getSignerSecret()]);
  return Boolean(addr && secret);
}
