import {
  BATCH_SIGNING_AVAILABLE,
  BATCH_SIGNING_UNAVAILABLE_MESSAGE,
  BatchSigningUnavailableError,
  executeBulkPayout,
  isTransactionHash,
  runBulkPayout,
  submitBatchUnavailable,
  type PayoutRow,
} from '../bulkPayout';

const ROWS: PayoutRow[] = [
  { recipient: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', amount: '10', asset: 'XLM' },
  { recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', amount: '2.5', asset: 'XLM' },
];
const HASH = 'a'.repeat(64);

describe('bulk payout honesty (issue 922)', () => {
  it('reports batch signing as unavailable in this build', () => {
    expect(BATCH_SIGNING_AVAILABLE).toBe(false);
  });

  it('the default submitter refuses rather than returning a result', async () => {
    await expect(submitBatchUnavailable(ROWS)).rejects.toBeInstanceOf(BatchSigningUnavailableError);
    await expect(submitBatchUnavailable(ROWS)).rejects.toThrow(BATCH_SIGNING_UNAVAILABLE_MESSAGE);
  });

  it('the done state is unreachable with the default submitter: the outcome is a failure', async () => {
    const outcome = await runBulkPayout(ROWS);
    expect(outcome).toEqual({ status: 'failed', message: BATCH_SIGNING_UNAVAILABLE_MESSAGE });
    expect(outcome).not.toHaveProperty('txHash');
  });

  it('the old placeholder submitter can no longer produce a payout', async () => {
    const placeholder = async (batch: PayoutRow[]) => ({
      txHash: `pending-${Date.now().toString(36)}`,
      rowIndices: batch.map((_, i) => i),
    });
    const result = await executeBulkPayout(ROWS, placeholder);
    expect(result.txHash).toBe('');
    expect(result.failedRows).toEqual([0, 1]);

    const outcome = await runBulkPayout(ROWS, placeholder);
    expect(outcome.status).toBe('failed');
  });

  it('never surfaces a non-hash as a transaction hash', async () => {
    for (const txHash of ['', 'pending-abc', 'a'.repeat(63), 'g'.repeat(64)]) {
      const outcome = await runBulkPayout(ROWS, async (batch) => ({ txHash, rowIndices: batch.map((_, i) => i) }));
      expect(outcome.status).toBe('failed');
    }
  });

  it('a failed submission is a failure of every row', async () => {
    const result = await executeBulkPayout(ROWS, async () => {
      throw new Error('network down');
    });
    expect(result).toEqual({ txHash: '', completedRows: [], failedRows: [0, 1] });
  });

  it('only a submitted transaction covering every row reaches the submitted state', async () => {
    const ok = await runBulkPayout(ROWS, async (batch) => ({ txHash: HASH, rowIndices: batch.map((_, i) => i) }));
    expect(ok).toEqual({ status: 'submitted', txHash: HASH, count: 2 });

    const partial = await runBulkPayout(ROWS, async () => ({ txHash: HASH, rowIndices: [0] }));
    expect(partial.status).toBe('failed');
  });

  it('refuses an empty batch', async () => {
    expect((await runBulkPayout([], async () => ({ txHash: HASH, rowIndices: [] }))).status).toBe('failed');
  });

  it('isTransactionHash accepts only 64 hex characters', () => {
    expect(isTransactionHash(HASH)).toBe(true);
    expect(isTransactionHash('pending-m1x9k2')).toBe(false);
    expect(isTransactionHash(undefined)).toBe(false);
  });
});
