import { StrKey } from '@stellar/stellar-sdk';

export type PayoutRow = {
    recipient: string;
    amount: string;
    asset: string;
};

export type ValidationError = {
    row: number;
    field: string;
    error: string;
};

export type ParseResult = {
    rows: PayoutRow[];
    errors: ValidationError[];
};

export type BatchState = {
    batchId: string;
    totalRows: number;
    completedRows: number[];
    txHashes: Record<number, string>;
    startedAt: number;
};

export type PayoutResult = {
    batchId: string;
    txHashes: Record<number, string>;
    completedRows: number[];
    failedRows: number[];
};

export function parseCSV(csvText: string): ParseResult {
    const lines = csvText.split(/\r?\n/);
    const rows: PayoutRow[] = [];
    const errors: ValidationError[] = [];

    if (lines.length === 0) return { rows, errors };

    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const recipientIdx = header.indexOf('recipient');
    const amountIdx = header.indexOf('amount');
    const assetIdx = header.indexOf('asset');

    if (recipientIdx === -1 || amountIdx === -1 || assetIdx === -1) {
        errors.push({ row: 0, field: 'header', error: 'Missing required columns: recipient, amount, asset' });
        return { rows, errors };
    }

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const cols = line.split(',').map(c => c.trim());
        const recipient = cols[recipientIdx] ?? '';
        const amount = cols[amountIdx] ?? '';
        const asset = cols[assetIdx] ?? '';
        const rowIndex = i;
        let rowHasError = false;

        if (!StrKey.isValidEd25519PublicKey(recipient)) {
            errors.push({ row: rowIndex, field: 'recipient', error: `Invalid Stellar address: ${recipient}` });
            rowHasError = true;
        }

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            errors.push({ row: rowIndex, field: 'amount', error: `Invalid amount: ${amount}` });
            rowHasError = true;
        }

        if (!asset) {
            errors.push({ row: rowIndex, field: 'asset', error: 'Asset cannot be empty' });
            rowHasError = true;
        }

        if (!rowHasError) {
            rows.push({ recipient, amount, asset });
        }
    }

    return { rows, errors };
}

export function createBatches(rows: PayoutRow[], batchSize = 100): PayoutRow[][] {
    const batches: PayoutRow[][] = [];
    for (let i = 0; i < rows.length; i += batchSize) {
        batches.push(rows.slice(i, i + batchSize));
    }
    return batches;
}

export function initBatchState(rows: PayoutRow[]): BatchState {
    const batchId =
        typeof crypto !== 'undefined' && typeof (crypto as { randomUUID?: () => string }).randomUUID === 'function'
            ? (crypto as { randomUUID: () => string }).randomUUID()
            : Date.now().toString(36);
    return {
        batchId,
        totalRows: rows.length,
        completedRows: [],
        txHashes: {},
        startedAt: Date.now(),
    };
}

const stateKey = (batchId: string) => `veil_bulk_payout_${batchId}`;

export function saveBatchState(state: BatchState): void {
    localStorage.setItem(stateKey(state.batchId), JSON.stringify(state));
}

export function loadBatchState(batchId: string): BatchState | null {
    const item = localStorage.getItem(stateKey(batchId));
    if (!item) return null;
    try {
        return JSON.parse(item) as BatchState;
    } catch {
        return null;
    }
}

export function clearBatchState(batchId: string): void {
    localStorage.removeItem(stateKey(batchId));
}

export async function executePayout(
    rows: PayoutRow[],
    state: BatchState,
    submitBatch: (
        batch: PayoutRow[],
        rowIndices: number[]
    ) => Promise<{ txHash: string; rowIndices: number[] }>,
    onProgress?: (state: BatchState) => void,
    batchSize = 100
): Promise<PayoutResult> {
    const completedSet = new Set(state.completedRows);
    const failedRows: number[] = [];
    const current: BatchState = { ...state, completedRows: [...state.completedRows], txHashes: { ...state.txHashes } };

    const batches = createBatches(rows, batchSize);
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const baseOffset = batchIdx * batchSize;
        const batchRows: PayoutRow[] = [];
        const batchIndices: number[] = [];

        for (let j = 0; j < batch.length; j++) {
            const globalIdx = baseOffset + j;
            if (!completedSet.has(globalIdx)) {
                batchRows.push(batch[j]);
                batchIndices.push(globalIdx);
            }
        }

        if (batchRows.length === 0) continue;

        try {
            const result = await submitBatch(batchRows, batchIndices);
            for (const idx of result.rowIndices) {
                completedSet.add(idx);
                current.completedRows.push(idx);
                current.txHashes[idx] = result.txHash;
            }
            saveBatchState(current);
            onProgress?.(current);
        } catch {
            for (const idx of batchIndices) {
                failedRows.push(idx);
            }
        }
    }

    return {
        batchId: current.batchId,
        txHashes: current.txHashes,
        completedRows: current.completedRows,
        failedRows,
    };
}
