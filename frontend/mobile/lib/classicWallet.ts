/**
 * Classic keypair wallet lifecycle — generate or import a Stellar keypair,
 * conditionally fund it via Friendbot on testnet, and persist it as the active
 * wallet.
 *
 * This provides the keypair-based fallback when passkey enrollment is
 * unavailable on a device, as well as an Expo-Go-friendly path for development.
 */

import { Keypair } from '@stellar/stellar-sdk';

import { getNetwork } from './network';
import { setSignerSecret, setWalletAddress, getWalletAddress, getSignerSecret } from './walletStore';

/**
 * Fund an account with the network's Friendbot. Resolves true on success.
 *
 * Friendbot is a testnet-only service. On mainnet, this returns false
 * immediately because mainnet has no faucet.
 */
export async function fundWithFriendbot(address: string): Promise<boolean> {
  const network = getNetwork();
  if (network.name !== 'testnet' || !network.friendbotUrl) {
    return false; // mainnet has no faucet
  }
  try {
    const res = await fetch(`${network.friendbotUrl}?addr=${encodeURIComponent(address)}`);
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
  /** Why the recovery secret could not be bound, when `recoverable` is false. */
  recoveryIssue?: 'unsupported' | 'cancelled' | 'failed';
};

/**
 * Create a fresh classic keypair wallet: generate a keypair and persist it as
 * the active wallet. On testnet, it is automatically funded via Friendbot; on
 * mainnet, Friendbot is bypassed and the unfunded account must be funded
 * externally by sending XLM.
 */
export async function createClassicWallet(): Promise<CreatedWallet> {
  const kp = Keypair.random();
  const address = kp.publicKey();
  await Promise.all([setSignerSecret(kp.secret()), setWalletAddress(address)]);

  // Friendbot funding is a testnet-only step. On mainnet, a classic account
  // has no faucet and must be funded externally.
  const network = getNetwork();
  const funded =
    network.name === 'testnet' && network.friendbotUrl
      ? await fundWithFriendbot(address)
      : false;

  return { address, funded };
}

/**
 * Import an existing classic wallet from a secret seed. Validates the seed and
 * persists it. On testnet, it tops it up from Friendbot if the account isn't
 * funded yet; on mainnet, Friendbot is bypassed.
 */
export async function importClassicWallet(secret: string): Promise<CreatedWallet> {
  const kp = Keypair.fromSecret(secret.trim()); // throws on a malformed seed
  const address = kp.publicKey();
  await Promise.all([setSignerSecret(kp.secret()), setWalletAddress(address)]);

  // Friendbot funding is a testnet-only step. On mainnet, existing accounts
  // already have balances or must be funded externally.
  const network = getNetwork();
  const funded =
    network.name === 'testnet' && network.friendbotUrl
      ? await fundWithFriendbot(address)
      : false;

  return { address, funded };
}

/** Whether a signable wallet key is present on this device. */
export async function hasWalletKey(): Promise<boolean> {
  const [addr, secret] = await Promise.all([getWalletAddress(), getSignerSecret()]);
  return Boolean(addr && secret);
}
