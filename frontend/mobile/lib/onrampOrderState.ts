/**
 * Pure state-transition logic for the NGN buy (onramp) flow.
 *
 * Extracted from `app/buy-ngn.tsx` so every path — especially the difference
 * between an unpaid window timing out and a user who already tapped
 * "I've sent the transfer" — is deterministic and unit-tested.
 *
 * Key invariants:
 * - A user who said they paid (`waiting`) is NEVER sent to `expired` and NEVER
 *   told "nothing was charged". When the deposit window closes, they move to
 *   `waiting_late` and polling continues for `LATE_CHECK_GRACE_MS`.
 * - If a late transfer arrives during `waiting_late`, the screen moves to `done`.
 * - If the bounded grace window ends without confirmation, the screen moves to
 *   `unconfirmed` (never `failed` and never telling them to pay again) and the
 *   stored order is cleared.
 * - If the provider explicitly reports a failed/cancelled order, the screen
 *   leaves `pay`/`waiting`/`waiting_late` for `failed`, hiding the account
 *   details and stopping the poll.
 */

export type OnrampStep =
  | 'amount'
  | 'confirm'
  | 'pay'
  | 'waiting'
  | 'waiting_late'
  | 'unconfirmed'
  | 'done'
  | 'expired'
  | 'failed';

/**
 * How long after `expiresAt` we keep polling and retaining a saved order when
 * the user has already tapped "I've sent the transfer".
 */
export const LATE_CHECK_GRACE_MS = 10 * 60_000;

export interface OnrampTransition {
  step: OnrampStep;
  forgetOrder: boolean;
}

/** True while the screen should keep polling status and running the timer. */
export function shouldPollOnramp(step: OnrampStep): boolean {
  return step === 'pay' || step === 'waiting' || step === 'waiting_late';
}

/**
 * Whether a stored order should still be kept on launch.
 *
 * Unpaid orders are dropped as soon as `expiresAt` passes so the app never
 * restores a closed account number to pay. Orders where the user already said
 * they sent the transfer are kept for `LATE_CHECK_GRACE_MS` past `expiresAt`
 * so polling can resume across a restart.
 */
export function isOrderRetentionActive(
  expiresAt: string,
  paidClaimed: boolean,
  nowMs: number = Date.now(),
): boolean {
  const expMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expMs)) return false;
  const deadline = paidClaimed ? expMs + LATE_CHECK_GRACE_MS : expMs;
  return nowMs < deadline;
}

/**
 * Which step to restore a persisted order into on launch, or `null` if the
 * order is past its retention deadline and should be dropped.
 */
export function resolveRestoredOnrampStep(
  expiresAt: string,
  paidClaimed: boolean,
  nowMs: number = Date.now(),
): 'pay' | 'waiting' | 'waiting_late' | null {
  const expMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expMs)) return null;

  if (paidClaimed) {
    if (nowMs < expMs) return 'waiting';
    if (nowMs < expMs + LATE_CHECK_GRACE_MS) return 'waiting_late';
    return null;
  }

  return nowMs < expMs ? 'pay' : null;
}

/** Whole seconds remaining in the post-expiry late-checking window. */
export function lateCheckSecondsRemaining(
  expiresAt: string,
  nowMs: number = Date.now(),
): number {
  const expMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expMs)) return 0;
  const ms = expMs + LATE_CHECK_GRACE_MS - nowMs;
  return Math.max(0, Math.floor(ms / 1000));
}

/**
 * Advance the step on a clock tick.
 */
export function transitionOnTick(
  step: OnrampStep,
  expiresAt: string,
  nowMs: number = Date.now(),
): OnrampTransition {
  const expMs = new Date(expiresAt).getTime();
  const validExpMs = Number.isFinite(expMs) ? expMs : 0;

  if (step === 'pay') {
    if (nowMs >= validExpMs) {
      return { step: 'expired', forgetOrder: true };
    }
    return { step: 'pay', forgetOrder: false };
  }

  if (step === 'waiting') {
    if (nowMs >= validExpMs + LATE_CHECK_GRACE_MS) {
      return { step: 'unconfirmed', forgetOrder: true };
    }
    if (nowMs >= validExpMs) {
      return { step: 'waiting_late', forgetOrder: false };
    }
    return { step: 'waiting', forgetOrder: false };
  }

  if (step === 'waiting_late') {
    if (nowMs >= validExpMs + LATE_CHECK_GRACE_MS) {
      return { step: 'unconfirmed', forgetOrder: true };
    }
    return { step: 'waiting_late', forgetOrder: false };
  }

  return { step, forgetOrder: false };
}

/**
 * Advance the step when a status poll returns a provider status string.
 */
export function transitionOnStatus(
  step: OnrampStep,
  status: string,
): OnrampTransition {
  if (!shouldPollOnramp(step)) {
    return { step, forgetOrder: false };
  }

  if (/complete|success|settled/i.test(status)) {
    return { step: 'done', forgetOrder: true };
  }

  if (/fail|cancel/i.test(status)) {
    return { step: 'failed', forgetOrder: true };
  }

  return { step, forgetOrder: false };
}
