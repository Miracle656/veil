/**
 * Plain English for a rejected Stellar transaction, on the web.
 *
 * A tester sent money from the web wallet on 2026-10-15 and was told
 * "Transaction failed — Request failed with status code 400". That sentence is
 * axios describing an HTTP response, and it is the only thing the screen had to
 * offer, because the send page ran every failure through `passkeyErrorMessage`
 * and that function's last resort is the raw `Error.message`.
 *
 * Horizon returns 400 for *every* rejected transaction. The status says nothing;
 * the reason is in `extras.result_codes`, which was being discarded. So a
 * destination that does not exist, an account below its reserve, a missing
 * trustline and a stale sequence number all reached the user as the same
 * sentence — and none of them as something they could act on.
 *
 * This is a deliberate copy of `frontend/mobile/lib/horizonError.ts` rather than
 * a shared module, for the reason the fee client gives: the two clients unwrap
 * different error shapes, and the wording is a product decision that should not
 * change on one platform because someone edited the other. What differs here is
 * the unwrapping — the mobile helper is handed the failure document, while on
 * web the stellar-sdk wraps it in an axios error and buries it at
 * `response.data`.
 */

/** Horizon's failure document, as much of it as matters here. */
type HorizonFailure = {
  extras?: {
    result_codes?: {
      transaction?: string
      operations?: string[]
    }
  }
}

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
}

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
}

/**
 * Dig the failure document out of whatever the caller caught.
 *
 * Three shapes reach here and all three are real: the document itself, an axios
 * error carrying it at `response.data`, and the stellar-sdk's own `NetworkError`
 * which keeps it in the same place but is not an axios error. Checking one shape
 * is how a translator silently stops translating.
 */
function failureDocument(value: unknown): HorizonFailure | null {
  if (!value || typeof value !== 'object') return null

  const direct = value as HorizonFailure
  if (direct.extras?.result_codes) return direct

  const nested = (value as { response?: { data?: unknown } }).response?.data
  if (nested && typeof nested === 'object' && (nested as HorizonFailure).extras?.result_codes) {
    return nested as HorizonFailure
  }

  return null
}

/**
 * A readable message for a Horizon failure, or null when the value is not one.
 *
 * Returning null rather than a fallback sentence is what lets a caller chain
 * this ahead of its existing handling: a cancelled passkey is not a Horizon
 * failure and must not be described as one.
 *
 * Operation codes are preferred over the transaction code: `tx_failed` only
 * says that something in the transaction failed, while the operation code says
 * which thing and why.
 */
export function horizonErrorMessage(value: unknown): string | null {
  const codes = failureDocument(value)?.extras?.result_codes
  if (!codes) return null

  const failedOps = (codes.operations ?? []).filter((c) => c && c !== 'op_success')
  for (const code of failedOps) {
    const known = OPERATION_CODES[code]
    if (known) return known
  }

  const tx = codes.transaction
  if (tx && tx !== 'tx_failed') {
    return TRANSACTION_CODES[tx] ?? `The network rejected this transaction (${tx}).`
  }

  // `tx_failed` with only unrecognised operation codes: name them rather than
  // claiming to know what they mean. The code is still searchable, which the
  // HTTP status never was.
  if (failedOps.length > 0) {
    return `The network rejected this transaction (${failedOps.join(', ')}).`
  }

  return tx ? (TRANSACTION_CODES[tx] ?? `The network rejected this transaction (${tx}).`) : null
}
