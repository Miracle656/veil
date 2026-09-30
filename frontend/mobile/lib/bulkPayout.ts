import { StrKey } from '@stellar/stellar-sdk';

export type PayoutRow = {
  recipient: string;
  amount: string;
  asset: string;
};

export type RowValidation = {
  recipient?: string;
  amount?: string;
};

/** Validate a single recipient row. Returns an empty object when the row is valid. */
export function validateRow(row: PayoutRow): RowValidation {
  const errors: RowValidation = {};

  if (!StrKey.isValidEd25519PublicKey(row.recipient)) {
    errors.recipient = `Invalid Stellar address: ${row.recipient}`;
  }

  const amountNum = parseFloat(row.amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    errors.amount = `Invalid amount: ${row.amount}`;
  }

  return errors;
}

export function isRowValid(row: PayoutRow): boolean {
  const errors = validateRow(row);
  return Object.keys(errors).length === 0;
}

export type BatchSubmitResult = {
  txHash: string;
  rowIndices: number[];
};

export type PayoutResult = {
  txHash: string;
  completedRows: number[];
  failedRows: number[];
};

/**
 * Whether this build can build, sign and submit a batch. It cannot yet: no code
 * path here builds a transaction or asks the wallet signer for a signature.
 * While false the screen must say so and must never report a payout.
 * Flip it only together with a real `submitBatch` that returns the hash of a
 * transaction actually submitted to the network.
 */
export const BATCH_SIGNING_AVAILABLE = false;

export const BATCH_SIGNING_UNAVAILABLE_MESSAGE =
  'Batch signing is not available yet. No payments have been sent.';

export class BatchSigningUnavailableError extends Error {
  constructor() {
    super(BATCH_SIGNING_UNAVAILABLE_MESSAGE);
    this.name = 'BatchSigningUnavailableError';
  }
}

/** The submitter used until batch signing exists: refuses rather than pretending. */
export async function submitBatchUnavailable(_batch: PayoutRow[]): Promise<BatchSubmitResult> {
  throw new BatchSigningUnavailableError();
}

/** A Stellar transaction hash: 32 bytes as 64 hex characters. */
export function isTransactionHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

/**
 * Submit every recipient row as a single authorized batch.
 * `submitBatch` is called once for the whole list — one signature covers all rows.
 * A result only counts when it carries a real transaction hash; anything else
 * (a placeholder, an empty string) is a failure of every row.
 */
export async function executeBulkPayout(
  rows: PayoutRow[],
  submitBatch: (batch: PayoutRow[]) => Promise<BatchSubmitResult>
): Promise<PayoutResult> {
  try {
    const result = await submitBatch(rows);
    if (!isTransactionHash(result.txHash)) {
      throw new Error('Batch submission returned no transaction hash');
    }
    return {
      txHash: result.txHash,
      completedRows: result.rowIndices,
      failedRows: [],
    };
  } catch {
    return {
      txHash: '',
      completedRows: [],
      failedRows: rows.map((_, i) => i),
    };
  }
}

export type PayoutOutcome =
  | { status: 'submitted'; txHash: string; count: number }
  | { status: 'failed'; message: string };

/**
 * The only way to reach the "submitted" state: every row went out in a
 * transaction with a real hash. With no signer available the outcome is
 * always `failed`, carrying the plain "not available yet" message.
 */
export async function runBulkPayout(
  rows: PayoutRow[],
  submitBatch: (batch: PayoutRow[]) => Promise<BatchSubmitResult> = submitBatchUnavailable
): Promise<PayoutOutcome> {
  if (rows.length === 0) return { status: 'failed', message: 'Add at least one recipient.' };

  if (submitBatch === submitBatchUnavailable) {
    return { status: 'failed', message: BATCH_SIGNING_UNAVAILABLE_MESSAGE };
  }

  const result = await executeBulkPayout(rows, submitBatch);
  const allDone =
    result.failedRows.length === 0 &&
    result.completedRows.length === rows.length &&
    isTransactionHash(result.txHash);
  if (!allDone) {
    return { status: 'failed', message: 'The batch was not submitted. No payments were sent.' };
  }
  return { status: 'submitted', txHash: result.txHash, count: rows.length };
}
