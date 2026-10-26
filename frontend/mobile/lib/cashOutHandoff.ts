import type { CashOutIntent } from './agentMessages';

let pending: CashOutIntent | null = null;

/** Keep cash-out prefill out of route params, URLs, and persisted storage. */
export function setCashOutHandoff(intent: CashOutIntent): void {
  pending = { amountNGN: intent.amountNGN, rate: intent.rate };
}

/** Consume the in-memory hand-off once, when the Cash Out screen opens. */
export function consumeCashOutHandoff(): CashOutIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}
