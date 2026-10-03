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
 * Submit every recipient row as a single authorized batch.
 * `submitBatch` is called once for the whole list — one signature covers all rows.
 */
export async function executeBulkPayout(
  rows: PayoutRow[],
  submitBatch: (batch: PayoutRow[]) => Promise<BatchSubmitResult>
): Promise<PayoutResult> {
  try {
    const result = await submitBatch(rows);
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

// ── Real submission ───────────────────────────────────────────────────────────
//
// Why one transaction per row rather than one for the whole list: a Soroban
// transaction carries a single InvokeHostFunction operation, and the wallet's
// `__check_auth` authorises one root invocation per signature. Paying N
// recipients out of the smart wallet in ONE transaction would need an on-chain
// batch entry point (a router or a `batch_transfer`); neither the wallet nor
// the factory has one and the deployed contracts are not upgradeable. Until one
// exists each row is its own signed, submitted and confirmed transaction. That
// is stated on the screen, not implied.

/** Rows carried by one on-chain transaction today. Raise only with a batch entry point. */
export const MAX_ROWS_PER_TRANSACTION = 1;

/** Largest list the screen will accept: one passkey prompt per row is the practical ceiling. */
export const MAX_BATCH_ROWS = 20;

/** A Stellar transaction hash: 32 bytes, hex. Nothing else may be shown as one. */
const TX_HASH_RE = /^[0-9a-f]{64}$/i;

export function isTxHash(value: unknown): value is string {
  return typeof value === 'string' && TX_HASH_RE.test(value);
}

export type RowOutcome =
  | { index: number; status: 'submitted'; txHash: string }
  | { index: number; status: 'failed'; error: string }
  | { index: number; status: 'not_attempted' };

export type RowByRowResult = {
  outcomes: RowOutcome[];
  submitted: number[];
  failed: number[];
  notAttempted: number[];
};

/** Native XLM is the one asset a row can name by code alone. */
function isNativeCode(asset: string): boolean {
  return asset.trim().toUpperCase() === 'XLM';
}

/**
 * Problems that make the batch unsendable, found BEFORE anything is signed.
 * Rows only carry an asset code, and codes are not identities (several issuers
 * publish the same one), so only native XLM is accepted; an issued asset must
 * be pinned by issuer before it can be added here.
 */
export function batchProblems(rows: PayoutRow[]): string[] {
  const problems: string[] = [];
  if (rows.length === 0) problems.push('Add at least one recipient.');
  if (rows.length > MAX_BATCH_ROWS) {
    problems.push(
      `A batch is limited to ${MAX_BATCH_ROWS} recipients (each is its own signed transaction). Split it into smaller batches.`,
    );
  }
  rows.forEach((row, i) => {
    const errs = validateRow(row);
    if (errs.recipient) problems.push(`Row ${i + 1}: ${errs.recipient}`);
    if (errs.amount) problems.push(`Row ${i + 1}: ${errs.amount}`);
    if (!isNativeCode(row.asset)) {
      problems.push(
        `Row ${i + 1}: only XLM is supported; "${row.asset}" cannot be paid because an asset code does not identify its issuer.`,
      );
    }
  });
  return problems;
}

/**
 * Pays each row with `sendRow` (build, sign, submit, confirm; resolves to the
 * transaction hash) and reports the outcome PER ROW.
 *
 * - A row is `submitted` only when `sendRow` resolved to a real transaction
 *   hash; anything else is `failed`.
 * - The first failure (including a cancelled passkey prompt) stops the run, so
 *   the user is not prompted to sign for the remaining rows after something went
 *   wrong. Those rows are reported `not_attempted` and none of them was sent.
 */
export async function executeRowByRow(
  rows: PayoutRow[],
  sendRow: (row: PayoutRow, index: number) => Promise<string>,
  describeError: (e: unknown) => string = (e) => (e instanceof Error ? e.message : String(e)),
): Promise<RowByRowResult> {
  const problems = batchProblems(rows);
  if (problems.length > 0) throw new Error(problems.join('\n'));

  const outcomes: RowOutcome[] = [];
  let stopped = false;
  for (let index = 0; index < rows.length; index++) {
    if (stopped) {
      outcomes.push({ index, status: 'not_attempted' });
      continue;
    }
    try {
      const txHash = await sendRow(rows[index], index);
      if (!isTxHash(txHash)) throw new Error('The network returned no transaction hash for this payment.');
      outcomes.push({ index, status: 'submitted', txHash });
    } catch (e) {
      outcomes.push({ index, status: 'failed', error: describeError(e) });
      stopped = true;
    }
  }

  const pick = (s: RowOutcome['status']) => outcomes.filter((o) => o.status === s).map((o) => o.index);
  return {
    outcomes,
    submitted: pick('submitted'),
    failed: pick('failed'),
    notAttempted: pick('not_attempted'),
  };
}

export type BulkView = 'done' | 'partial' | 'failed';

/**
 * Which end state the screen may show. `done` is reachable only when EVERY row
 * has a submitted transaction with a real hash; a run with none submitted is
 * `failed`, so no success copy can appear without a submitted transaction.
 */
export function bulkView(result: RowByRowResult, rowCount: number): BulkView {
  const allSubmitted =
    rowCount > 0 &&
    result.submitted.length === rowCount &&
    result.outcomes.every((o) => o.status === 'submitted' && isTxHash(o.txHash));
  if (allSubmitted) return 'done';
  return result.submitted.length > 0 ? 'partial' : 'failed';
}
