/**
 * Deploy the wallet contract on first use, with the public key it was made from.
 *
 * The SDK's `deploy()` finds the passkey public key only under its own storage
 * key, which a wallet signed in on this device through recovery never wrote.
 * So a wallet holding real money at its (not-yet-deployed) address could not be
 * spent from: every send, swap and cash-out from the smart wallet failed with
 * "No public key found. Call register() first", while the key was sitting in the
 * secure store or, failing that, in the wallet's own recovery entries on chain.
 *
 * The key is resolved from all three sources below, and used only if it derives
 * to exactly the wallet address being deployed. The address is a pure function
 * of the factory, the network and the key, so a key that derives elsewhere would
 * deploy a different, empty contract — refusing is the only safe answer.
 *
 * The third source exists because the first two can both be empty through no
 * fault of the user: a wallet created while its fee-payer was still unfunded
 * could not write breadcrumbs, and a later `ensureBreadcrumbs` retry records
 * only `veil:wallet` when the secure store has no key either. Such a wallet
 * holds real money at an address nothing can deploy. Recovering the key from a
 * passkey signature fixes those wallets without a backup or a redeploy.
 */

import { Buffer } from 'buffer';
import { computeWalletAddress } from '@veil/sdk';

import { getFeePayerAddress } from './activity';
import { isWalletDeployed } from './contractSpend';
import { getNetwork } from './network';
import { recoverWalletPublicKey } from './recoverPasskeyKey';
import { readBreadcrumbs } from './walletBreadcrumbs';
import { getPasskeyPublicKey, getSignerSecret, setPasskeyPublicKey } from './walletStore';

/** The SDK deploy, as the wallet provider exposes it. */
export type DeployFn = (signerSecret: string, publicKeyBytes?: Uint8Array) => Promise<unknown>;

function hexKey(hex: string | null): Uint8Array | null {
  if (!hex || !/^[0-9a-fA-F]{130}$/.test(hex)) return null;
  const bytes = new Uint8Array(Buffer.from(hex, 'hex'));
  return bytes[0] === 0x04 ? bytes : null;
}

/**
 * The 65-byte public key that derives to `walletAddress`, or null.
 *
 * Secure store first, since it needs no network. Then the recovery entries on the
 * spending account, which exist for exactly this case; a key found there is
 * written back to the secure store so the next deploy needs no lookup.
 *
 * Last, when `allowPasskeyPrompt`, the passkey itself: one assertion recovers the
 * key cryptographically. That costs a prompt, so it is opt-in and callers that
 * only want to preview a transaction pass false and get null instead.
 */
export async function resolveWalletPublicKey(
  walletAddress: string,
  allowPasskeyPrompt = false,
): Promise<Uint8Array | null> {
  const net = getNetwork();

  const stored = hexKey(await getPasskeyPublicKey().catch(() => null));
  if (stored && computeWalletAddress(net.factoryContractId, stored, net.networkPassphrase) === walletAddress) {
    return stored;
  }

  const feePayer = await getFeePayerAddress();
  if (!feePayer) return null;
  const crumbs = await readBreadcrumbs(feePayer);
  // readBreadcrumbs derives walletAddress from the key it read, so equality here
  // is the same derivation check as above.
  if (crumbs?.publicKeyBytes && crumbs.walletAddress === walletAddress) {
    void setPasskeyPublicKey(Buffer.from(crumbs.publicKeyBytes).toString('hex')).catch(() => undefined);
    return crumbs.publicKeyBytes;
  }

  // Nothing recorded the key. Ask the passkey to sign, and recover it from the
  // signature — `recoverWalletPublicKey` accepts a candidate only when it
  // reproduces `walletAddress`, so this is the same derivation check again.
  if (allowPasskeyPrompt) return recoverWalletPublicKey(walletAddress);

  return null;
}

/** Deploy the wallet contract if it is not on chain yet. No-op when it is. */
export async function deployWalletIfNeeded(deploy: DeployFn, walletAddress: string): Promise<void> {
  if (await isWalletDeployed(walletAddress)) return;

  const secret = await getSignerSecret();
  if (!secret) {
    throw new Error('No spending key on this device to pay for setting up the wallet on-chain.');
  }

  const publicKey = await resolveWalletPublicKey(walletAddress, true);
  if (!publicKey) {
    throw new Error(
      "This device couldn't confirm the passkey for this wallet, so it can't set the wallet up on-chain yet. " +
        'Make sure you approve the passkey prompt with the passkey this wallet was created with. ' +
        'Your funds are safe at the wallet address.',
    );
  }

  await deploy(secret, publicKey);
}
