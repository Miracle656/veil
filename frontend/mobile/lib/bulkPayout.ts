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
