/**
 * Fail-closed preflight for an assistant payment backed by a wallet allowance.
 *
 * This is deliberately separate from transaction construction and signing.
 * The deployed wallet contract is the final authority: it debits the same
 * allowance during authorization. This check prevents an order or submission
 * when the server cannot prove that the payment fits the allowance it just
 * read.
 */

export interface AllowanceSnapshot {
  /** Remaining amount in the token's smallest unit. */
  amount: bigint
  /** Unix timestamp at which the allowance stops being valid. */
  expiry?: bigint
}

export type AllowanceFailure =
  | 'allowance_unavailable'
  | 'allowance_missing'
  | 'allowance_expired'
  | 'allowance_insufficient'
  | 'payment_amount_invalid'

export class AllowanceError extends Error {
  readonly code: AllowanceFailure

  constructor(code: AllowanceFailure, message: string) {
    super(message)
    this.name = 'AllowanceError'
    this.code = code
  }
}

export interface AllowanceReader {
  readAllowance(): Promise<AllowanceSnapshot | null>
}

/**
 * Check one payment against a freshly-read allowance.
 *
 * `now` is injectable so callers and tests use the same chain timestamp they
 * used for the read. Expiry is exclusive, matching the wallet contract.
 */
export function assertAllowanceCovers(
  allowance: AllowanceSnapshot | null,
  paymentAmount: bigint,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): void {
  if (paymentAmount <= 0n) {
    throw new AllowanceError('payment_amount_invalid', 'Payment amount must be positive.')
  }
  if (!allowance) {
    throw new AllowanceError('allowance_missing', 'No allowance is registered for this payment.')
  }
  if (allowance.amount < 0n) {
    throw new AllowanceError('allowance_insufficient', 'The allowance is not sufficient for this payment.')
  }
  if (allowance.expiry !== undefined && now >= allowance.expiry) {
    throw new AllowanceError('allowance_expired', 'The payment allowance has expired.')
  }
  if (paymentAmount > allowance.amount) {
    throw new AllowanceError('allowance_insufficient', 'The payment is above the remaining allowance.')
  }
}

/**
 * Read and check the allowance immediately before a payment is built or
 * submitted. A read error is never treated as an empty or unlimited allowance.
 */
export async function assertFreshAllowance(
  reader: AllowanceReader,
  paymentAmount: bigint,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Promise<void> {
  let allowance: AllowanceSnapshot | null
  try {
    allowance = await reader.readAllowance()
  } catch {
    throw new AllowanceError(
      'allowance_unavailable',
      'The payment allowance could not be read, so the payment was not attempted.',
    )
  }
  assertAllowanceCovers(allowance, paymentAmount, now)
}
