/**
 * Loading older history pages.
 *
 * The history used to stop after one Horizon page: many operations yield no
 * feed row (trustlines, data entries, deploys), so an active wallet ran out of
 * visible history long before Horizon ran out of operations. Paging is keyed on
 * the paging token of the oldest operation seen, so pages never overlap.
 *
 * Horizon and Soroban RPC are mocked. No network, and addresses come from
 * `Keypair.random()`.
 */

import { Address, Horizon, Keypair, StrKey, rpc, xdr } from '@stellar/stellar-sdk';

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: jest.fn() },
    rpc: { ...actual.rpc, Server: jest.fn() },
  };
});

jest.mock('../network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    horizonUrl: 'https://horizon.test.invalid',
    rpcUrl: 'https://rpc.test.invalid',
  }),
}));

jest.mock('../activity', () => ({ getFeePayerAddress: jest.fn() }));

import { getFeePayerAddress } from '../activity';
import { loadHorizonActivity, loadHorizonActivityPage } from '../horizonActivity';

const mockGetFeePayerAddress = getFeePayerAddress as unknown as jest.Mock;
const MockHorizonServer = Horizon.Server as unknown as jest.Mock;
const MockRpcServer = rpc.Server as unknown as jest.Mock;

function randomAccount(): string {
  return Keypair.random().publicKey();
}

type MockBuilder = { limit: jest.Mock; cursor: jest.Mock; call: jest.Mock };

let builder: MockBuilder;
let rpcGetEvents: jest.Mock;

/** One Horizon operation that becomes a received payment row. */
function paymentOp(id: string, pagingToken: string, account: string, other: string): Record<string, unknown> {
  return {
    id,
    paging_token: pagingToken,
    type: 'payment',
    transaction_hash: `hash-${id}`,
    created_at: '2026-01-01T00:00:00Z',
    asset_type: 'native',
    amount: '1.0000000',
    from: other,
    to: account,
  };
}

/** A classic page entry that produces no feed row at all. */
function changeTrustOp(id: string, pagingToken: string): Record<string, unknown> {
  return {
    id,
    paging_token: pagingToken,
    type: 'change_trust',
    transaction_hash: `hash-${id}`,
    created_at: '2026-01-01T00:00:00Z',
  };
}

/** A SAC `transfer` event as Soroban RPC returns it. */
function sacEvent(input: {
  id: string;
  txHash: string;
  from: string;
  to: string;
  amount: number;
  ledgerClosedAt: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    txHash: input.txHash,
    topic: [
      xdr.ScVal.scvSymbol('transfer'),
      xdr.ScVal.scvAddress(new Address(input.from).toScAddress()),
      xdr.ScVal.scvAddress(new Address(input.to).toScAddress()),
      xdr.ScVal.scvSymbol('native'),
    ],
    value: xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString('0'),
        lo: xdr.Int64.fromString(String(input.amount)),
      }),
    ),
    ledgerClosedAt: input.ledgerClosedAt,
  };
}

/** A contract (C...) address derived from a random keypair; never real. */
function contractAddress(): string {
  return StrKey.encodeContract(StrKey.decodeEd25519PublicKey(Keypair.random().publicKey()));
}

beforeEach(() => {
  const b = {} as MockBuilder;
  b.limit = jest.fn(() => b);
  b.cursor = jest.fn(() => b);
  b.call = jest.fn();
  builder = b;
  MockHorizonServer.mockImplementation(() => ({
    operations: () => ({ forAccount: () => ({ order: () => b }) }),
  }));

  rpcGetEvents = jest.fn().mockResolvedValue({ events: [] });
  MockRpcServer.mockImplementation(() => ({
    getLatestLedger: jest.fn().mockResolvedValue({ sequence: 5_000_000 }),
    getEvents: rpcGetEvents,
  }));

  mockGetFeePayerAddress.mockReset();
  mockGetFeePayerAddress.mockResolvedValue(null);
});

describe('loadHorizonActivityPage', () => {
  it('returns the paging token of the oldest operation as the cursor', async () => {
    const me = randomAccount();
    const other = randomAccount();
    builder.call.mockResolvedValue({
      records: [
        paymentOp('op-new', 'token-new', me, other),
        paymentOp('op-old', 'token-old', me, other),
      ],
    });

    const page = await loadHorizonActivityPage(me, 100);

    expect(page.records.map((r) => r.id)).toEqual(['op-new', 'op-old']);
    expect(page.nextCursor).toBe('token-old');
    expect(builder.cursor).not.toHaveBeenCalled();
  });

  it('loads the next page from that cursor, and adds no duplicate rows', async () => {
    const me = randomAccount();
    const other = randomAccount();
    builder.call.mockResolvedValueOnce({
      records: [paymentOp('op-new', 'token-new', me, other)],
    });
    const first = await loadHorizonActivityPage(me, 100);
    expect(first.nextCursor).toBe('token-new');

    builder.call.mockResolvedValueOnce({
      records: [paymentOp('op-older', 'token-older', me, other)],
    });
    const second = await loadHorizonActivityPage(me, 100, first.nextCursor!);

    expect(builder.cursor).toHaveBeenCalledWith('token-new');
    expect(second.records.map((r) => r.id)).toEqual(['op-older']);
    expect(second.nextCursor).toBe('token-older');
  });

  it('reports no older page when Horizon returns an empty page', async () => {
    const me = randomAccount();
    builder.call.mockResolvedValue({ records: [] });

    const page = await loadHorizonActivityPage(me, 100, 'token-oldest');

    expect(page.records).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a failed older page so the screen can offer a retry', async () => {
    const me = randomAccount();
    builder.call.mockRejectedValue(new Error('Horizon is down'));

    await expect(loadHorizonActivityPage(me, 100, 'token-old')).rejects.toThrow('Horizon is down');
  });

  it('still degrades to an empty first load when Horizon fails', async () => {
    const me = randomAccount();
    builder.call.mockRejectedValue(new Error('Horizon is down'));

    await expect(loadHorizonActivity(me, 100)).resolves.toEqual([]);
  });

  it('pages a smart wallet from Horizon alone, without rescanning RPC events', async () => {
    const feePayer = randomAccount();
    mockGetFeePayerAddress.mockResolvedValue(feePayer);
    builder.call.mockResolvedValue({ records: [] });

    const page = await loadHorizonActivityPage(contractAddress(), 100, 'token-old');

    expect(builder.cursor).toHaveBeenCalledWith('token-old');
    expect(rpcGetEvents).not.toHaveBeenCalled();
    expect(page).toEqual({ records: [], nextCursor: null });
  });
});

/**
 * The cursor used to be the paging token of the last operation in the fetched
 * page, but the page is over-fetched and the loop stops once `limit` rows
 * exist. Every operation after that point was never shown and was skipped
 * forever — 100 visible rows out of a 200-payment page lost operations 101–200.
 */
describe('the cursor follows the last row actually shown', () => {
  it('resumes right after the cutoff when a page is longer than the limit', async () => {
    const me = randomAccount();
    const other = randomAccount();
    builder.call.mockResolvedValueOnce({
      records: [1, 2, 3, 4, 5, 6].map((n) =>
        paymentOp(`op-${n}`, `token-${n}`, me, other),
      ),
    });

    const first = await loadHorizonActivityPage(me, 3);

    expect(first.records.map((r) => r.id)).toEqual(['op-1', 'op-2', 'op-3']);
    // Not token-6: operations 4–6 were never turned into rows.
    expect(first.nextCursor).toBe('token-3');

    builder.call.mockResolvedValueOnce({
      records: [4, 5, 6].map((n) => paymentOp(`op-${n}`, `token-${n}`, me, other)),
    });
    const second = await loadHorizonActivityPage(me, 3, first.nextCursor!);

    expect(builder.cursor).toHaveBeenCalledWith('token-3');
    const ids = [...first.records, ...second.records].map((r) => r.id);
    expect(ids).toEqual(['op-1', 'op-2', 'op-3', 'op-4', 'op-5', 'op-6']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('steps over operations that produce no row without losing the ones after them', async () => {
    const me = randomAccount();
    const other = randomAccount();
    builder.call.mockResolvedValueOnce({
      records: [
        paymentOp('op-1', 'token-1', me, other),
        changeTrustOp('ct-1', 'token-ct-1'),
        paymentOp('op-2', 'token-2', me, other),
        changeTrustOp('ct-2', 'token-ct-2'),
        paymentOp('op-3', 'token-3', me, other),
      ],
    });

    const first = await loadHorizonActivityPage(me, 2);

    expect(first.records.map((r) => r.id)).toEqual(['op-1', 'op-2']);
    // The next operation in the feed after op-2 is ct-2, so resuming there
    // still reaches op-3.
    expect(first.nextCursor).toBe('token-2');

    builder.call.mockResolvedValueOnce({
      records: [changeTrustOp('ct-2', 'token-ct-2'), paymentOp('op-3', 'token-3', me, other)],
    });
    const second = await loadHorizonActivityPage(me, 2, first.nextCursor!);

    expect(builder.cursor).toHaveBeenCalledWith('token-2');
    expect(second.records.map((r) => r.id)).toEqual(['op-3']);
  });

  it('does not skip classic rows a smart-wallet merge trimmed away', async () => {
    const contract = contractAddress();
    const feePayer = randomAccount();
    mockGetFeePayerAddress.mockResolvedValue(feePayer);
    builder.call.mockResolvedValueOnce({
      records: [
        paymentOp('op-1', 'token-1', feePayer, contract),
        paymentOp('op-2', 'token-2', feePayer, contract),
        paymentOp('op-3', 'token-3', feePayer, contract),
      ],
    });
    rpcGetEvents.mockResolvedValue({
      events: [
        sacEvent({
          id: 'event-1',
          txHash: 'hash-event-1',
          from: feePayer,
          to: contract,
          amount: 100_000_000,
          ledgerClosedAt: '2099-01-01T00:00:00Z',
        }),
      ],
    });

    const first = await loadHorizonActivityPage(contract, 3);

    // The newest three rows are the event and the two newest classic rows, so
    // op-3 was built but trimmed off the screen.
    expect(first.records.map((r) => r.id)).toEqual(['event-1', 'op-1', 'op-2']);
    // Resume after op-2 rather than past the whole classic page: op-3 must come
    // back on the next page instead of vanishing.
    expect(first.nextCursor).toBe('token-2');

    builder.call.mockResolvedValueOnce({
      records: [paymentOp('op-3', 'token-3', feePayer, contract)],
    });
    const second = await loadHorizonActivityPage(contract, 3, first.nextCursor!);

    expect(builder.cursor).toHaveBeenCalledWith('token-2');
    expect(second.records.map((r) => r.id)).toEqual(['op-3']);
  });

  it('keeps every row when a smart-wallet merge would drop all classic rows', async () => {
    const contract = contractAddress();
    const feePayer = randomAccount();
    mockGetFeePayerAddress.mockResolvedValue(feePayer);
    builder.call.mockResolvedValueOnce({
      records: [
        paymentOp('op-1', 'token-1', feePayer, contract),
        paymentOp('op-2', 'token-2', feePayer, contract),
      ],
    });
    rpcGetEvents.mockResolvedValue({
      events: ['event-1', 'event-2'].map((id, i) =>
        sacEvent({
          id,
          txHash: `hash-${id}`,
          from: feePayer,
          to: contract,
          amount: 100_000_000,
          ledgerClosedAt: `2099-01-0${2 - i}T00:00:00Z`,
        }),
      ),
    });

    const first = await loadHorizonActivityPage(contract, 2);

    // Both contract events are newer than the classic rows. Making room for a
    // classic row must not replace the oldest row on screen (event-2): contract
    // rows cannot be paged, so a replaced one would never be shown again. The
    // page runs one row long instead, and the cursor still has a shown classic
    // operation to resume from.
    expect(first.records.map((r) => r.id)).toEqual(['event-1', 'event-2', 'op-1']);
    expect(first.nextCursor).toBe('token-1');

    builder.call.mockResolvedValueOnce({
      records: [paymentOp('op-2', 'token-2', feePayer, contract)],
    });
    const second = await loadHorizonActivityPage(contract, 2, first.nextCursor!);

    expect(second.records.map((r) => r.id)).toEqual(['op-2']);
    const ids = [...first.records, ...second.records].map((r) => r.id);
    expect(ids).toEqual(['event-1', 'event-2', 'op-1', 'op-2']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
