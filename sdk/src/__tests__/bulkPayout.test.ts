import {
    parseCSV,
    createBatches,
    initBatchState,
    saveBatchState,
    loadBatchState,
    clearBatchState,
    executePayout,
    PayoutRow,
    BatchState,
} from '../bulkPayout';

// jsdom provides localStorage
const VALID_ADDRESS = 'GAHDZ7EHMFJX3SSM4F7KJR5KO242RCP7OBVSIEPBJXFYDYVZPVC5BQ4Y';
const VALID_ADDRESS_2 = 'GC57UNN6UYA3FGJW6Y5BXGWCQ7OBHDSOVA5HCIKBDJ5OJ3U6J3EN3FVI';

describe('parseCSV()', () => {
    it('parses a valid CSV correctly', () => {
        const csv = `recipient,amount,asset\n${VALID_ADDRESS},10.5,XLM\n${VALID_ADDRESS_2},25,USDC`;
        const { rows, errors } = parseCSV(csv);
        expect(errors).toHaveLength(0);
        expect(rows).toHaveLength(2);
        expect(rows[0].recipient).toBe(VALID_ADDRESS);
        expect(rows[0].amount).toBe('10.5');
        expect(rows[0].asset).toBe('XLM');
        expect(rows[1].amount).toBe('25');
    });

    it('handles case-insensitive header and whitespace', () => {
        const csv = `  Recipient , Amount , Asset \n${VALID_ADDRESS}, 5 , XLM`;
        const { rows, errors } = parseCSV(csv);
        expect(errors).toHaveLength(0);
        expect(rows).toHaveLength(1);
    });

    it('invalid Stellar address → ValidationError on recipient', () => {
        const csv = `recipient,amount,asset\nNOT_A_VALID_ADDRESS,10,XLM`;
        const { errors } = parseCSV(csv);
        expect(errors.some(e => e.field === 'recipient')).toBe(true);
    });

    it('negative amount → ValidationError on amount', () => {
        const csv = `recipient,amount,asset\n${VALID_ADDRESS},-5,XLM`;
        const { errors } = parseCSV(csv);
        expect(errors.some(e => e.field === 'amount')).toBe(true);
    });

    it('zero amount → ValidationError on amount', () => {
        const csv = `recipient,amount,asset\n${VALID_ADDRESS},0,XLM`;
        const { errors } = parseCSV(csv);
        expect(errors.some(e => e.field === 'amount')).toBe(true);
    });

    it('non-numeric amount → ValidationError on amount', () => {
        const csv = `recipient,amount,asset\n${VALID_ADDRESS},abc,XLM`;
        const { errors } = parseCSV(csv);
        expect(errors.some(e => e.field === 'amount')).toBe(true);
    });

    it('empty asset → ValidationError on asset', () => {
        const csv = `recipient,amount,asset\n${VALID_ADDRESS},10,`;
        const { errors } = parseCSV(csv);
        expect(errors.some(e => e.field === 'asset')).toBe(true);
    });

    it('skips blank lines', () => {
        const csv = `recipient,amount,asset\n\n${VALID_ADDRESS},10,XLM\n\n`;
        const { rows } = parseCSV(csv);
        expect(rows).toHaveLength(1);
    });

    it('missing required header → error', () => {
        const csv = `address,amount,token\n${VALID_ADDRESS},10,XLM`;
        const { errors } = parseCSV(csv);
        expect(errors.some(e => e.field === 'header')).toBe(true);
    });
});

describe('createBatches()', () => {
    it('splits 250 rows into 3 batches of 100/100/50', () => {
        const rows: PayoutRow[] = Array.from({ length: 250 }, (_, i) => ({
            recipient: VALID_ADDRESS,
            amount: '1',
            asset: 'XLM',
        }));
        const batches = createBatches(rows);
        expect(batches).toHaveLength(3);
        expect(batches[0]).toHaveLength(100);
        expect(batches[1]).toHaveLength(100);
        expect(batches[2]).toHaveLength(50);
    });

    it('custom batch size', () => {
        const rows: PayoutRow[] = Array.from({ length: 10 }, () => ({
            recipient: VALID_ADDRESS,
            amount: '1',
            asset: 'XLM',
        }));
        const batches = createBatches(rows, 3);
        expect(batches).toHaveLength(4);
        expect(batches[3]).toHaveLength(1);
    });
});

describe('BatchState persistence', () => {
    beforeEach(() => localStorage.clear());

    it('saves and loads BatchState', () => {
        const rows: PayoutRow[] = [{ recipient: VALID_ADDRESS, amount: '1', asset: 'XLM' }];
        const state = initBatchState(rows);
        saveBatchState(state);
        const loaded = loadBatchState(state.batchId);
        expect(loaded).not.toBeNull();
        expect(loaded!.batchId).toBe(state.batchId);
        expect(loaded!.totalRows).toBe(1);
    });

    it('loadBatchState returns null for unknown id', () => {
        expect(loadBatchState('nonexistent-id')).toBeNull();
    });

    it('clearBatchState removes the entry', () => {
        const state = initBatchState([]);
        saveBatchState(state);
        clearBatchState(state.batchId);
        expect(loadBatchState(state.batchId)).toBeNull();
    });
});

describe('executePayout()', () => {
    beforeEach(() => localStorage.clear());

    const makeRows = (n: number): PayoutRow[] =>
        Array.from({ length: n }, (_, i) => ({
            recipient: VALID_ADDRESS,
            amount: String(i + 1),
            asset: 'XLM',
        }));

    it('submits all rows and records txHashes', async () => {
        const rows = makeRows(3);
        const state = initBatchState(rows);
        const submitBatch = jest.fn().mockImplementation(
            async (_batch: PayoutRow[], rowIndices: number[]) => ({
                txHash: 'hash-' + rowIndices[0],
                rowIndices,
            })
        );

        const result = await executePayout(rows, state, submitBatch);
        expect(result.completedRows).toHaveLength(3);
        expect(result.failedRows).toHaveLength(0);
        expect(Object.keys(result.txHashes)).toHaveLength(3);
    });

    it('skips already-completed rows (resume test)', async () => {
        const rows = makeRows(3);
        const state = initBatchState(rows);
        // Mark row 0 as already completed
        state.completedRows = [0];
        state.txHashes = { 0: 'already-done' };

        const submitBatch = jest.fn().mockImplementation(
            async (_batch: PayoutRow[], rowIndices: number[]) => ({
                txHash: 'new-hash',
                rowIndices,
            })
        );

        const result = await executePayout(rows, state, submitBatch);
        // Row 0 should still be there from the pre-populated state
        expect(result.completedRows).toContain(0);
        expect(result.txHashes[0]).toBe('already-done');
        // submitBatch should not have been called with row 0
        const allSubmitted = submitBatch.mock.calls.flatMap(
            ([_b, indices]: [PayoutRow[], number[]]) => indices
        );
        expect(allSubmitted).not.toContain(0);
    });

    it('no duplicate payments — second call skips completed rows', async () => {
        const rows = makeRows(5);
        const state = initBatchState(rows);

        let callCount = 0;
        const submitBatch = jest.fn().mockImplementation(
            async (_batch: PayoutRow[], rowIndices: number[]) => {
                callCount++;
                return { txHash: `hash-${callCount}`, rowIndices };
            }
        );

        // First call
        const result1 = await executePayout(rows, state, submitBatch);
        const callsAfterFirst = callCount;

        // Second call with completed state from result1
        const state2: BatchState = {
            ...state,
            completedRows: result1.completedRows,
            txHashes: result1.txHashes,
        };

        const submitBatch2 = jest.fn().mockImplementation(
            async (_batch: PayoutRow[], rowIndices: number[]) => ({
                txHash: 'should-not-happen',
                rowIndices,
            })
        );
        await executePayout(rows, state2, submitBatch2);
        // All rows were completed; submitBatch2 should never be called
        expect(submitBatch2).not.toHaveBeenCalled();
    });

    it('failed batch → rows appear in failedRows', async () => {
        const rows = makeRows(3);
        const state = initBatchState(rows);

        const submitBatch = jest.fn().mockRejectedValue(new Error('network error'));
        const result = await executePayout(rows, state, submitBatch);
        expect(result.failedRows.length).toBeGreaterThan(0);
        expect(result.completedRows).toHaveLength(0);
    });
});
