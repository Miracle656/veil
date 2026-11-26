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
 * - It only ever moves XLM **to the wallet's own PRF fee-payer**. The
 *   destination is derived, never passed in from a caller or a screen.
 * - It refuses unless the source account's breadcrumbs name the contract's own
 *   signer. See `planFeePayerRecovery`.
 * - It is best-effort and never throws into a sign-in. A failed sweep leaves
 *   the money exactly where it already was, which is the state the user is
 *   already in; a sign-in that fails because of it would be strictly worse.
 */
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

import { planFeePayerRecovery, type RecoveryPlan } from './feePayerRecovery';
import { readBreadcrumbs } from './walletBreadcrumbs';

export type AccountSnapshot = {
  /** XLM balance, or null when the account does not exist on the network. */
  xlm: number | null;
  /** Trustlines, data entries, extra signers — anything that holds reserve. */
  subentryCount: number;
};

export type SweepDeps = {
  /** Reads an account, or null when Horizon has never heard of it. */
  loadAccount: (address: string) => Promise<AccountSnapshot | null>;
  /** The P-256 signer recorded in that account's breadcrumbs, if any. */
  readCrumbSigner: (address: string) => Promise<Uint8Array | null>;
  /** The signer the wallet contract actually holds. */
  readWalletSigner: (walletAddress: string) => Promise<Uint8Array | null>;
  /** Moves `amount` XLM from the legacy secret's account to `to`. */
  sendXlm: (fromSecret: string, to: string, amount: string) => Promise<string>;
};

/** Why nothing moved: a plan's own refusal, or a failure carrying it out. */
export type SweepSkipped =
  | Extract<RecoveryPlan, { action: 'none' }>['reason']
  | 'no-legacy-secret'
  | 'sweep-failed';

export type SweepOutcome =
  | { swept: true; amount: string; txHash: string; from: string; to: string }
  | { swept: false; reason: SweepSkipped | string };

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
    const needsProof = !!args.legacyAddress && !!legacy && (legacy.xlm ?? 0) > 0;
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
      legacyCrumbSigner: crumbSigner,
      walletSigner,
    });

    if (plan.action === 'none') return { swept: false, reason: plan.reason };
    if (!args.legacySecret) return { swept: false, reason: 'no-legacy-secret' };

    const txHash = await deps.sendXlm(args.legacySecret, plan.to, plan.amount);
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
  };
}

/** Build and submit the sweep payment. Separated so the test never signs. */
export async function submitSweep(
  fromSecret: string,
  to: string,
  amount: string,
  net: { horizonUrl: string; networkPassphrase: string },
  fee: string,
): Promise<string> {
  const server = new Horizon.Server(net.horizonUrl);
  const kp = Keypair.fromSecret(fromSecret);
  const account = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee, networkPassphrase: net.networkPassphrase })
    // A payment, not accountMerge: the account carries data entries and a
    // trustline, and a merge is rejected outright while any subentry remains.
    // Merging would also destroy the breadcrumbs, which are the only proof
    // tying this account to the wallet.
    .addOperation(Operation.payment({ destination: to, asset: Asset.native(), amount }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const result = await server.submitTransaction(tx);
  return (result as { hash: string }).hash;
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
    sendXlm: (fromSecret, to, amount) => submitSweep(fromSecret, to, amount, net, fee),
  };
}
