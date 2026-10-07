/**
 * The bulk payout screen used to resolve every time with a synthetic
 * `pending-…` hash and tell the user everyone was paid. These tests pin the
 * opposite: the success state is reachable only through real, submitted
 * transactions, and every failure is reported per row.
 */
import { StrKey } from '@stellar/stellar-sdk';
import {
  MAX_BATCH_ROWS,
  batchProblems,
  bulkView,
  executeRowByRow,
  isTxHash,
  type PayoutRow,
} from '../bulkPayout';

const A = 'GDTPMJKU2WUR2JQUJSIF6GN5SQRTJVRJGJJ7PI3ZWIENYYGJ33MVETQO';
const B = 'GACXZYIBHOK5EGU6CTXOT7EQ24JANLH5C6QNWFGV5BUWLDTOZCP3BTNM';
const C = 'GBMIW5MPL2Y5OFUHBXKSB7GNRISC6JOOTM2MBTWF424OJLLC5FGJIVVX';

const HASH = (n: number) => n.toString(16).padStart(64, '0');
const row = (recipient: string, amount = '1', asset = 'XLM'): PayoutRow => ({ recipient, amount, asset });

describe('fixtures', () => {
  it('uses checksum-valid addresses', () => {
    for (const g of [A, B, C]) expect(StrKey.isValidEd25519PublicKey(g)).toBe(true);
  });
});

describe('isTxHash', () => {
  it('accepts a 64-hex hash and nothing that looks like the old placeholder', () => {
    expect(isTxHash(HASH(1))).toBe(true);
    expect(isTxHash('pending-m1x9k2')).toBe(false);
    expect(isTxHash('')).toBe(false);
    expect(isTxHash(undefined)).toBe(false);
  });
});

describe('batchProblems', () => {
  it('flags an empty batch, bad rows, non-XLM assets and oversized batches', () => {
    expect(batchProblems([])).toHaveLength(1);
    expect(batchProblems([row('not-an-address')])[0]).toMatch(/Row 1: Invalid Stellar address/);
    expect(batchProblems([row(A, '0')])[0]).toMatch(/Row 1: Invalid amount/);
    expect(batchProblems([row(A, '1', 'USDC')])[0]).toMatch(/only XLM is supported/);
    expect(batchProblems(Array.from({ length: MAX_BATCH_ROWS + 1 }, () => row(A)))[0]).toMatch(/limited to/);
    expect(batchProblems([row(A), row(B, '2.5', 'xlm')])).toEqual([]);
  });
});

describe('executeRowByRow', () => {
  it('submits every row and reports real hashes; done is reachable', async () => {
    const send = jest.fn(async (_r: PayoutRow, i: number) => HASH(i + 1));
    const result = await executeRowByRow([row(A), row(B), row(C)], send);
    expect(send).toHaveBeenCalledTimes(3);
    expect(result.submitted).toEqual([0, 1, 2]);
    expect(result.failed).toEqual([]);
    expect(bulkView(result, 3)).toBe('done');
  });

  it('refuses an unsendable batch before signing anything', async () => {
    const send = jest.fn(async () => HASH(1));
    await expect(executeRowByRow([row(A), row(B, '1', 'USDC')], send)).rejects.toThrow(/only XLM/);
    await expect(executeRowByRow([row('nope')], send)).rejects.toThrow(/Invalid Stellar address/);
    expect(send).not.toHaveBeenCalled();
  });

  it('the done state is unreachable when nothing was submitted', async () => {
    const result = await executeRowByRow([row(A), row(B)], async () => {
      throw new Error('boom');
    });
    expect(result.submitted).toEqual([]);
    expect(bulkView(result, 2)).toBe('failed');
  });

  it('a fabricated hash is a failure, never a submitted row', async () => {
    const result = await executeRowByRow([row(A)], async () => `pending-${Date.now().toString(36)}`);
    expect(result.outcomes[0]).toMatchObject({ status: 'failed' });
    expect(bulkView(result, 1)).toBe('failed');
  });

  it('partial failure names the rows that did not go through and stops signing', async () => {
    const send = jest.fn(async (_r: PayoutRow, i: number) => {
      if (i === 1) throw new Error('op_underfunded');
      return HASH(i + 1);
    });
    const result = await executeRowByRow([row(A), row(B), row(C)], send);
    expect(send).toHaveBeenCalledTimes(2); // row 3 was never sent
    expect(result.submitted).toEqual([0]);
    expect(result.failed).toEqual([1]);
    expect(result.notAttempted).toEqual([2]);
    expect(result.outcomes[1]).toEqual({ index: 1, status: 'failed', error: 'op_underfunded' });
    expect(bulkView(result, 3)).toBe('partial');
  });

  it('a cancelled passkey prompt on the first row submits nothing', async () => {
    const send = jest.fn(async () => {
      throw new Error('USER_REJECTED');
    });
    const result = await executeRowByRow([row(A), row(B)], send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(bulkView(result, 2)).toBe('failed');
  });
});

describe('bulkView', () => {
  it('is never done unless every row has a hash', () => {
    expect(
      bulkView(
        {
          outcomes: [{ index: 0, status: 'submitted', txHash: 'pending-x' }],
          submitted: [0],
          failed: [],
          notAttempted: [],
        },
        1,
      ),
    ).toBe('partial');
  });
});
