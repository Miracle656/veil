/**
 * Plain English for a rejected Stellar transaction.
 *
 * Horizon reports a failure as a document whose readable half is a paragraph
 * about where to find documentation, and whose useful half is a set of short
 * codes buried at `extras.result_codes`. Shown raw it is a wall of JSON with an
 * XDR blob in the middle — which is what a user saw when a swap failed.
 *
 * The codes are the part worth reading, so this turns them into a sentence that
 * says what went wrong and what would fix it. Anything unrecognised falls back
 * to the code itself, which is still shorter and more searchable than the
 * document that carried it.
 */

/** Horizon's failure document, as much of it as matters here. */
type HorizonFailure = {
  extras?: {
    result_codes?: {
      transaction?: string;
      operations?: string[];
    };
  };
};

/**
 * Transaction-level codes.
 *
 * `tx_insufficient_balance` is the one worth spelling out: it does not mean the
 * account is empty, it means the balance would fall below the reserve the
 * network locks — 1 XLM for the account plus 0.5 for every trustline, offer and
 * data entry it holds. An account showing 0.6 XLM with a trustline already open
 * has nothing spendable at all.
 */
const TRANSACTION_CODES: Record<string, string> = {
  tx_insufficient_balance:
    "This account doesn't have enough XLM. Stellar locks 1 XLM per account plus 0.5 for each trustline, and the balance can't drop below that.",
  tx_insufficient_fee: 'The network fee offered was too low. Try again in a moment.',
  tx_bad_seq: 'This transaction was built against a stale account state. Try again.',
  tx_bad_auth: 'This transaction was not signed by a key the account accepts.',
  tx_bad_auth_extra: 'This transaction carried a signature the account does not need.',
  tx_no_source_account: 'The account paying for this transaction does not exist on this network yet.',
  tx_too_late: 'This transaction expired before it reached the network. Try again.',
  tx_too_early: 'This transaction was submitted before its valid-from time.',
  tx_failed: 'One of the operations in this transaction failed.',
};

/** Operation-level codes, which say more than `tx_failed` on its own. */
const OPERATION_CODES: Record<string, string> = {
  op_underfunded: "There isn't enough of that asset in the account to send.",
  op_low_reserve:
    "This would leave the account below its reserve. Opening a trustline locks a further 0.5 XLM, so the account needs that much spare.",
  op_no_trust: 'The destination has not opted in to this asset yet.',
  op_no_destination: 'The destination account does not exist on this network.',
  op_line_full: 'The destination cannot hold any more of this asset.',
  op_no_issuer: 'The issuer of this asset does not exist.',
  op_under_dest_min: 'The price moved past the slippage limit before this went through. Try again.',
  op_over_source_max: 'The price moved past the slippage limit before this went through. Try again.',
  op_too_few_offers: 'There is not enough liquidity for this trade right now.',
  op_cross_self: 'This trade would have matched against your own offer.',
  op_malformed: 'This operation was rejected as malformed.',
};

/**
 * A readable message for a Horizon failure, or null when the value is not one.
 *
 * Operation codes are preferred over the transaction code: `tx_failed` only
 * says that something in the transaction failed, while the operation code says
 * which thing and why.
 */
export function horizonErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;

  const codes = (value as HorizonFailure).extras?.result_codes;
  if (!codes) return null;

  const failedOps = (codes.operations ?? []).filter((c) => c && c !== 'op_success');
  for (const code of failedOps) {
    const known = OPERATION_CODES[code];
    if (known) return known;
  }

  const tx = codes.transaction;
  if (tx && tx !== 'tx_failed') {
    return TRANSACTION_CODES[tx] ?? `The network rejected this transaction (${tx}).`;
  }

  // `tx_failed` with only unrecognised operation codes: name them rather than
  // claiming to know what they mean.
  if (failedOps.length > 0) {
    return `The network rejected this transaction (${failedOps.join(', ')}).`;
  }

  return tx ? (TRANSACTION_CODES[tx] ?? `The network rejected this transaction (${tx}).`) : null;
}
