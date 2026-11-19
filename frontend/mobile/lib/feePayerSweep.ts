/**
 * Carrying out the stranded-fee-payer recovery decided in `feePayerRecovery.ts`.
 *
 * Everything that touches the network is injected, so the orchestration can be
 * tested without Horizon and without a key. The default bindings live at the
 * bottom and are the only part that cannot be exercised in a unit test.
 *
 * This moves a user's money without asking them, so the rules it follows are
 * narrow on purpose:
 *
 * - It only ever moves funds **to the wallet's own PRF fee-payer**: XLM and
 *   every other asset the account holds, in one transaction (feePayerMove.ts).
 *   It used to move XLM alone, which left USDC behind on an account the app
 *   had stopped showing. The
 *   destination is derived, never passed in from a caller or a screen.
 * - It refuses unless the source account's breadcrumbs name the contract's own
 *   signer. See `planFeePayerRecovery`.
 * - It is best-effort and never throws into a sign-in. A failed sweep leaves
 *   the money exactly where it already was, which is the state the user is
 *   already in; a sign-in that fails because of it would be strictly worse.
 */
import { Horizon, Networks } from '@stellar/stellar-sdk';

import { planFeePayerRecovery, retainedForSweep, type RecoveryPlan } from './feePayerRecovery';
import { holdsOtherAssets, submitMove, MoveRefusedError, type MoveAccount, type MoveRefusal } from './feePayerMove';
import { readBreadcrumbs } from './walletBreadcrumbs';

export type AccountSnapshot = {
  /** XLM balance, or null when the account does not exist on the network. */
  xlm: number | null;
  /** Trustlines, data entries, extra signers — anything that holds reserve. */
  subentryCount: number;
  /** Whether the account holds any asset besides XLM. Absent means no. */
  hasOtherAssets?: boolean;
};

export type SweepDeps = {
  /** Reads an account, or null when Horizon has never heard of it. */
  loadAccount: (address: string) => Promise<AccountSnapshot | null>;
  /** The P-256 signer recorded in that account's breadcrumbs, if any. */
  readCrumbSigner: (address: string) => Promise<Uint8Array | null>;
  /** The signer the wallet contract actually holds. */
  readWalletSigner: (walletAddress: string) => Promise<Uint8Array | null>;
  /**
   * Moves `amount` XLM from the legacy secret's account to `to`, together with
   * every other asset that account holds. `toSecret` signs for the trustlines
   * the destination has to open; without it only XLM can cross, and an account
   * holding anything else is refused instead of half-moved.
   */
  sendXlm: (fromSecret: string, to: string, amount: string, toSecret?: string | null) => Promise<string>;
};

/** Why nothing moved: a plan's own refusal, or a failure carrying it out. */
export type SweepSkipped =
  | Extract<RecoveryPlan, { action: 'none' }>['reason']
  | 'no-legacy-secret'
  | 'sweep-failed';

export type SweepOutcome =
  | { swept: true; amount: string; txHash: string; from: string; to: string }
  | { swept: false; reason: SweepSkipped | MoveRefusal | string; shortfallXlm?: number };

/**
 * Look for a fee-payer stranded by the credential-id-to-PRF move, and bring it
 * across if — and only if — it can be proved to belong to this wallet.
 *
 * Returns what happened rather than throwing, so a caller can log it and carry
 * on regardless.
 */
export async function sweepStrandedFeePayer(
  args: {
    walletAddress: string;
    prfAddress: string;
    legacyAddress: string | null;
    legacySecret: string | null;
    /** Secret of `prfAddress`, so it can open trustlines for what arrives. */
    prfSecret?: string | null;
  },
  deps: SweepDeps,
): Promise<SweepOutcome> {
  try {
    const [prf, legacy] = await Promise.all([
      deps.loadAccount(args.prfAddress),
      args.legacyAddress ? deps.loadAccount(args.legacyAddress) : Promise.resolve(null),
    ]);

    // Read the proof only when there is something worth proving — a Horizon
    // round trip per sign-in for an account nobody funded is wasted.
    const needsProof =
      !!args.legacyAddress && !!legacy && ((legacy.xlm ?? 0) > 0 || !!legacy.hasOtherAssets);
    const [crumbSigner, walletSigner] = needsProof
      ? await Promise.all([
          deps.readCrumbSigner(args.legacyAddress as string),
          deps.readWalletSigner(args.walletAddress),
        ])
      : [null, null];

    const plan = planFeePayerRecovery({
      prfAddress: args.prfAddress,
      prfBalanceXlm: prf?.xlm ?? null,
      legacyAddress: args.legacyAddress,
      legacyBalanceXlm: legacy?.xlm ?? null,
      legacySubentryCount: legacy?.subentryCount ?? 0,
      legacyHasAssets: !!legacy?.hasOtherAssets,
      legacyCrumbSigner: crumbSigner,
      walletSigner,
    });

    if (plan.action === 'none') return { swept: false, reason: plan.reason };
    if (!args.legacySecret) return { swept: false, reason: 'no-legacy-secret' };

    const txHash = await deps.sendXlm(args.legacySecret, plan.to, plan.amount, args.prfSecret ?? null);
    return { swept: true, amount: plan.amount, txHash, from: plan.from, to: plan.to };
  } catch (error) {
    // The money has not moved, which is where it already was. Never let this
    // take a sign-in down with it.
    return { swept: false, reason: error instanceof Error ? error.message : 'sweep-failed' };
  }
}

// ── Default bindings ─────────────────────────────────────────────────────────

/** Horizon's account shape, reduced to what the plan needs. */
export function snapshotFromHorizon(account: {
  balances: Array<{ asset_type: string; balance: string }>;
  subentry_count: number;
}): AccountSnapshot {
  const native = account.balances.find((b) => b.asset_type === 'native');
  return {
    xlm: native ? Number(native.balance) : 0,
    subentryCount: account.subentry_count,
    hasOtherAssets: holdsOtherAssets(account as Pick<MoveAccount, 'balances'>),
  };
}

export const MAINNET_PASSPHRASE = Networks.PUBLIC;

/**
 * The real bindings.
 *
 * `walletSigner` is passed in rather than read back from the contract: at the
 * point this runs, the signer that just authenticated is already in hand, and
 * it is the same key the proof compares against. Re-reading it would be a
 * simulation round trip for an answer we were holding.
 */

/**
 * Move a wallet off a fee-payer that cannot be rebuilt from its passkey.
 *
 * A wallet created on build 10 or earlier read the SDK's credential id from
 * the BARE AsyncStorage key while the storage adapter was already writing it
 * per network. On mainnet that read returned null, PRF was never attempted,
 * and creation fell through to `Keypair.random()` — a fee-payer that exists in
 * one secure store and can be rebuilt from nothing. It dies with the install.
 * One user lost a funded account that way before this existed.
 *
 * An encrypted backup does not cover it: the backup holds the wallet address,
 * the signer PUBLIC keys and settings, never a private key. There is no file
 * that would have saved it, which is why this has to be repaired rather than
 * backed up.
 *
 * The repair is a move, not a swap. Adopting the passkey-derived key while the
 * old account still holds the money would stop anything reaching that balance
 * — which is why the binding retry refused outright whenever it found funds.
 * Sweeping first and adopting second turns that refusal into a fix.
 *
 * Unlike the stranded-fee-payer sweep above, this needs no breadcrumb proof:
 * the source is the account this wallet is already paying fees from and whose
 * secret is already in the secure store, and the destination is derived from
 * the user's own passkey. Neither is guessed.
 *
 * What stays behind is the account's reserve plus a little fee headroom — the
 * same arithmetic as the sweep. Reclaiming that too would mean merging the
 * account, which cannot be done while it holds subentries, and a failed merge
 * on a money path is a worse trade than leaving the reserve.
 */
export async function migrateFeePayerToPasskey(
  params: { from: string; fromSecret: string; to: string; toSecret?: string | null },
  deps: Pick<SweepDeps, 'loadAccount' | 'sendXlm'>,
): Promise<SweepOutcome> {
  if (params.from === params.to) return { swept: false, reason: 'same-account' };
  let snapshot: AccountSnapshot | null;
  try {
    snapshot = await deps.loadAccount(params.from);
  } catch {
    return { swept: false, reason: 'sweep-failed' };
  }
  // Never funded, or already emptied: there is nothing to move, and the
  // caller is free to adopt the passkey-derived key straight away.
  if (!snapshot || snapshot.xlm === null || snapshot.xlm <= 0) {
    return { swept: false, reason: 'legacy-empty' };
  }
  const retained = retainedForSweep(snapshot.subentryCount);
  const movable = snapshot.xlm - retained;
  // An account whose XLM is all reserve can still hold USDC. That has to move
  // before the key changes, or it is left on an account nothing can sign for.
  if (movable <= 0 && !snapshot.hasOtherAssets) return { swept: false, reason: 'below-reserve' };
  const amount = Math.max(0, movable).toFixed(7);
  try {
    const txHash = await deps.sendXlm(params.fromSecret, params.to, amount, params.toSecret ?? null);
    return { swept: true, amount, txHash, from: params.from, to: params.to };
  } catch (error) {
    // The money has not moved, so the caller must NOT adopt the new key.
    if (error instanceof MoveRefusedError) {
      return { swept: false, reason: error.reason, shortfallXlm: error.shortfallXlm };
    }
    return { swept: false, reason: 'sweep-failed' };
  }
}

export function defaultSweepDeps(
  walletSigner: Uint8Array | null,
  net: { horizonUrl: string; networkPassphrase: string },
  fee: string,
): SweepDeps {
  const server = new Horizon.Server(net.horizonUrl);
  return {
    loadAccount: async (address) => {
      try {
        const account = await server.loadAccount(address);
        return snapshotFromHorizon(account as unknown as Parameters<typeof snapshotFromHorizon>[0]);
      } catch {
        // Horizon answers 404 for an account that has never been funded, which
        // is the ordinary case here, not an error worth surfacing.
        return null;
      }
    },
    readCrumbSigner: async (address) => (await readBreadcrumbs(address))?.publicKeyBytes ?? null,
    readWalletSigner: async () => walletSigner,
    // Every asset, not XLM alone: see feePayerMove.ts for why a native-only
    // sweep followed by a key change loses money.
    sendXlm: (fromSecret, to, amount, toSecret) =>
      submitMove({ fromSecret, to, toSecret: toSecret ?? null, xlmAmount: amount, net, fee }),
  };
}
