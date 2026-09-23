/**
 * How to fund a deposit that runs from the spending account.
 *
 * Blend is called by the spending (fee-payer) account, but a wallet's money
 * often sits in the smart wallet instead. Kept pure, in stroops, so the
 * arithmetic that decides whether real money moves is testable on its own.
 */

const STROOPS = 10_000_000;

export type DepositPlan =
  /** The spending account already holds enough. */
  | { kind: 'ready' }
  /** Move this much (a 7-decimal string) from the smart wallet first. */
  | { kind: 'move'; amount: string }
  /** Both accounts together hold less than the deposit. */
  | { kind: 'short'; available: number };

function toStroops(units: number): number {
  return Math.max(0, Math.floor(units * STROOPS + 1e-6));
}

export function planDeposit(params: {
  amount: number;
  /** What the spending account can put in, already net of any reserve. */
  inSpending: number;
  inWallet: number;
}): DepositPlan {
  const want = Math.round(params.amount * STROOPS);
  const spending = toStroops(params.inSpending);
  const wallet = toStroops(params.inWallet);

  if (spending >= want) return { kind: 'ready' };
  const shortfall = want - spending;
  if (wallet < shortfall) {
    return { kind: 'short', available: (spending + wallet) / STROOPS };
  }
  return { kind: 'move', amount: (shortfall / STROOPS).toFixed(7) };
}
