/**
 * One-time cleanup for retired spending accounts left with reserve XLM.
 *
 * Users who moved off a random-key spending account before reserve-freeing and
 * `accountMerge` landed still have the old key stored in `retiredFeePayers`
 * (`walletStore.ts`), with ~2.60 XLM locked on the old account.
 *
 * This module checks those retired keys against Horizon and, when one still
 * holds XLM or assets, offers to bring everything across using `submitMove`.
 * A retired key is NEVER deleted until the network confirms the old account is
 * merged (404) or completely empty.
 */
import { Horizon, Keypair } from '@stellar/stellar-sdk';

import { inclusionFee } from './fees';
import { holdsOtherAssets, submitMove, type MoveAccount } from './feePayerMove';
import { getNetwork } from './network';
import {
  getRetiredFeePayerSecrets,
  getSignerSecret,
  removeRetiredFeePayerSecret,
} from './walletStore';

export type RetiredAccountSnapshot = {
  xlm: number;
  subentryCount: number;
  hasOtherAssets: boolean;
};

export type RetiredFeePayerCandidate = {
  secret: string;
  address: string;
  xlm: number;
  hasOtherAssets: boolean;
};

export type RetiredCleanupDeps = {
  getRetiredSecrets: () => Promise<string[]>;
  getCurrentSecret: () => Promise<string | null>;
  removeRetiredSecret: (secret: string) => Promise<void>;
  /** Returns null when Horizon reports 404 (merged or never funded). Throws on network error. */
  loadAccount: (address: string) => Promise<RetiredAccountSnapshot | null>;
  moveAccount: (params: {
    fromSecret: string;
    to: string;
    toSecret: string;
    xlmAmount: string;
  }) => Promise<string>;
};

export type ClaimRetiredOutcome =
  | { claimed: true; txHash: string; from: string; to: string; amountXlm: number }
  | { claimed: false; reason: string };

function isConfirmedEmptyOrMerged(snapshot: RetiredAccountSnapshot | null): boolean {
  if (snapshot === null) return true;
  return snapshot.xlm <= 0 && !snapshot.hasOtherAssets && snapshot.subentryCount === 0;
}

export function defaultRetiredCleanupDeps(): RetiredCleanupDeps {
  const net = getNetwork();
  const server = new Horizon.Server(net.horizonUrl);
  return {
    getRetiredSecrets: getRetiredFeePayerSecrets,
    getCurrentSecret: getSignerSecret,
    removeRetiredSecret: removeRetiredFeePayerSecret,
    loadAccount: async (address) => {
      try {
        const account = (await server.loadAccount(address)) as unknown as MoveAccount;
        const native = account.balances.find((b) => b.asset_type === 'native');
        return {
          xlm: native ? Number(native.balance) : 0,
          subentryCount: account.subentry_count,
          hasOtherAssets: holdsOtherAssets(account),
        };
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        const missing = status === 404 || (error instanceof Error && error.name === 'NotFoundError');
        if (missing) return null;
        throw error;
      }
    },
    moveAccount: (params) =>
      submitMove({
        fromSecret: params.fromSecret,
        to: params.to,
        toSecret: params.toSecret,
        xlmAmount: params.xlmAmount,
        net,
        fee: inclusionFee(),
      }),
  };
}

/**
 * Inspect retired spending keys on the device. Removes any whose account is
 * confirmed empty or merged on-chain, and returns the first one that still
 * holds XLM or assets.
 */
export async function findRetiredFeePayerWithBalance(
  deps: Pick<
    RetiredCleanupDeps,
    'getRetiredSecrets' | 'getCurrentSecret' | 'removeRetiredSecret' | 'loadAccount'
  > = defaultRetiredCleanupDeps(),
): Promise<RetiredFeePayerCandidate | null> {
  const [secrets, currentSecret] = await Promise.all([
    deps.getRetiredSecrets(),
    deps.getCurrentSecret(),
  ]);
  const currentAddress = currentSecret ? Keypair.fromSecret(currentSecret).publicKey() : null;

  for (const secret of secrets) {
    let address: string;
    try {
      address = Keypair.fromSecret(secret).publicKey();
    } catch {
      continue;
    }
    if (currentAddress && address === currentAddress) continue;

    let snapshot: RetiredAccountSnapshot | null;
    try {
      snapshot = await deps.loadAccount(address);
    } catch {
      // Network unreachable — never delete a retired key when state is unknown.
      continue;
    }

    if (isConfirmedEmptyOrMerged(snapshot)) {
      await deps.removeRetiredSecret(secret);
      continue;
    }

    if (snapshot && (snapshot.xlm > 0 || snapshot.hasOtherAssets)) {
      return {
        secret,
        address,
        xlm: snapshot.xlm,
        hasOtherAssets: snapshot.hasOtherAssets,
      };
    }
  }

  return null;
}

/**
 * Bring leftover XLM/assets from a retired spending account to the current
 * spending account and merge the old account. Only deletes the retired key
 * after confirming the old account is empty or merged.
 */
export async function claimRetiredFeePayer(
  candidate: RetiredFeePayerCandidate,
  deps: Pick<
    RetiredCleanupDeps,
    'getCurrentSecret' | 'removeRetiredSecret' | 'loadAccount' | 'moveAccount'
  > = defaultRetiredCleanupDeps(),
): Promise<ClaimRetiredOutcome> {
  const currentSecret = await deps.getCurrentSecret();
  if (!currentSecret) return { claimed: false, reason: 'no-current-key' };

  const to = Keypair.fromSecret(currentSecret).publicKey();
  if (to === candidate.address) return { claimed: false, reason: 'same-account' };

  try {
    const txHash = await deps.moveAccount({
      fromSecret: candidate.secret,
      to,
      toSecret: currentSecret,
      xlmAmount: '0',
    });

    try {
      const after = await deps.loadAccount(candidate.address);
      if (isConfirmedEmptyOrMerged(after)) {
        await deps.removeRetiredSecret(candidate.secret);
      }
    } catch {
      // Keep the retired key if post-move confirmation fails.
    }

    return {
      claimed: true,
      txHash,
      from: candidate.address,
      to,
      amountXlm: candidate.xlm,
    };
  } catch (error) {
    return {
      claimed: false,
      reason: error instanceof Error ? error.message : 'claim-failed',
    };
  }
}
