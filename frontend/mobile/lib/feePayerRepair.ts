/**
 * Rescuing a **random fallback** fee-payer while its secret still exists.
 *
 * `createPasskeyWallet` falls back to `Keypair.random()` when the passkey
 * returns no PRF output. That key is derivable from nothing: it lives in this
 * device's storage and nowhere else. The encrypted backup excludes secrets, and
 * the breadcrumbs on the account record the *wallet*, not the key. So the
 * moment the user clears app data, reinstalls without a restore, or loses the
 * phone, whatever sits in that account is gone for good.
 *
 * That has already happened once on mainnet: 6.8650850 XLM stranded in an
 * account whose secret no longer exists anywhere.
 *
 * ## Why this is not `feePayerRecovery.ts`
 *
 * That module rescues the *legacy credential-id* fee-payer, and it can afford
 * to be lazy about it: the key is **re-derivable**, so the rescue works on any
 * future sign-in. It finds its candidate with `deriveFeePayerKeypair(keyId)`,
 * which by construction can never name a random account.
 *
 * A random fee-payer has exactly one window — now, on this device. So the
 * source here is the secret the app is *currently holding*, never a derivation.
 *
 * ## Why it merges rather than sweeping
 *
 * A payment leaves the reserve behind, and for these accounts the reserve is
 * most of the money: an account with a trustline and two data entries locks
 * 2.5 XLM, which is the entire balance of one of the two users this was written
 * for. Recovering that means removing every subentry and merging the account,
 * so this plans the whole sequence and the executor submits it as **one
 * transaction** — a half-finished teardown on someone's only escape route would
 * be worse than not starting.
 *
 * A trustline holding a balance cannot be closed, and classic operations cannot
 * pay a contract, so a token balance blocks the merge until it is moved over
 * Soroban. The planner names that rather than silently recovering less.
 */

import {
    ACCOUNT_RESERVE_XLM,
    SWEEP_FEE_HEADROOM_XLM,
    retainedForSweep,
} from './feePayerRecovery';
import type { FeePayerSource } from './feePayerSource';

/** Below this, moving XLM costs more attention than it returns. */
export const DUST_XLM = 0.01;

export type RepairTrustline = {
    code: string;
    issuer: string;
    balance: number;
};

export type RepairInputs = {
    /** What `recordFeePayerSource` last wrote for the account in use. */
    source: FeePayerSource;
    /** The fee-payer the app is using, whose secret is in hand. */
    currentAddress: string;
    /** Its XLM balance, or null when the account does not exist. */
    currentXlm: number | null;
    /** Everything holding reserve on it — Horizon's own count, not a guess. */
    currentSubentryCount: number;
    currentTrustlines: RepairTrustline[];
    currentDataNames: string[];
    /** The PRF-derived fee-payer, or null when the passkey returned no PRF. */
    derivedAddress: string | null;
    /** Its XLM balance, or null when it has never been funded. */
    derivedXlm: number | null;
};

export type RepairStep =
    | { step: 'close-trustline'; code: string; issuer: string }
    | { step: 'delete-data'; name: string }
    | { step: 'create-destination'; amount: string }
    | { step: 'merge' }
    | { step: 'send-xlm'; amount: string };

/** Something real is in the way, named so a screen can say what to do. */
export type RepairBlocker = {
    blocker: 'token-balance';
    code: string;
    issuer: string;
    balance: number;
};

export type RepairRefusal =
    /** The passkey returned no PRF output, so there is no safe destination. */
    | 'no-prf'
    /** The fee-payer in use is already derivable; nothing here to rescue. */
    | 'not-random'
    /** The derivation produced the account already in use. */
    | 'same-account'
    /** Nothing on the network, or nothing in it. */
    | 'source-empty'
    /** Funded, but every drop is reserve and nothing can be released. */
    | 'below-reserve';

export type RepairPlan =
    | { action: 'none'; reason: RepairRefusal }
    | {
          /** Reachable now, but a token balance stops the account being closed. */
          action: 'blocked';
          from: string;
          to: string;
          blockers: RepairBlocker[];
      }
    | {
          action: 'repair';
          from: string;
          to: string;
          /** In submission order. The executor sends them as one transaction. */
          steps: RepairStep[];
          /** XLM the destination should end up with, minus fee headroom. */
          recoverableXlm: string;
          /** Whether the source account is closed, or merely drained. */
          closesAccount: boolean;
          /** Present when the recovery is partial, saying what held it back. */
          blockers: RepairBlocker[];
      };

/**
 * Decide how to get a random fee-payer's balance onto the PRF-derived one.
 *
 * Pure: every network answer is an input, so each refusal is testable on its
 * own and no decision depends on reaching Horizon twice.
 */
export function planFeePayerRepair(input: RepairInputs): RepairPlan {
    if (!input.derivedAddress) return { action: 'none', reason: 'no-prf' };
    if (input.source !== 'random') return { action: 'none', reason: 'not-random' };
    if (input.currentAddress === input.derivedAddress) {
        return { action: 'none', reason: 'same-account' };
    }
    if (input.currentXlm === null || input.currentXlm <= 0) {
        return { action: 'none', reason: 'source-empty' };
    }

    const blockers: RepairBlocker[] = input.currentTrustlines
        .filter((line) => line.balance > 0)
        .map((line) => ({
            blocker: 'token-balance' as const,
            code: line.code,
            issuer: line.issuer,
            balance: line.balance,
        }));

    // Nothing holds a balance, so every subentry can go and the account itself
    // can be merged — which is the only way to release its own 1 XLM reserve.
    if (blockers.length === 0) {
        const steps: RepairStep[] = [
            ...input.currentTrustlines.map((line) => ({
                step: 'close-trustline' as const,
                code: line.code,
                issuer: line.issuer,
            })),
            ...input.currentDataNames.map((name) => ({ step: 'delete-data' as const, name })),
        ];

        // `accountMerge` requires a destination that exists, so an unfunded one
        // is created out of the balance being rescued. It is paid for from the
        // same account a moment before it is emptied, which is why both have to
        // be in one transaction.
        if (input.derivedXlm === null) {
            steps.push({ step: 'create-destination', amount: ACCOUNT_RESERVE_XLM.toFixed(7) });
        }
        steps.push({ step: 'merge' });

        const recoverable = input.currentXlm - SWEEP_FEE_HEADROOM_XLM;
        if (recoverable < DUST_XLM) return { action: 'none', reason: 'below-reserve' };

        return {
            action: 'repair',
            from: input.currentAddress,
            to: input.derivedAddress,
            steps,
            recoverableXlm: recoverable.toFixed(7),
            closesAccount: true,
            blockers,
        };
    }

    // A token balance is in the way. The trustline cannot be closed while it
    // holds anything and classic operations cannot pay a contract, so the most
    // that can be done is move the XLM sitting above the reserve.
    const retained = retainedForSweep(input.currentSubentryCount);
    const movable = input.currentXlm - retained;
    if (movable < DUST_XLM) {
        return {
            action: 'blocked',
            from: input.currentAddress,
            to: input.derivedAddress,
            blockers,
        };
    }

    return {
        action: 'repair',
        from: input.currentAddress,
        to: input.derivedAddress,
        steps: [{ step: 'send-xlm', amount: movable.toFixed(7) }],
        recoverableXlm: movable.toFixed(7),
        closesAccount: false,
        blockers,
    };
}
