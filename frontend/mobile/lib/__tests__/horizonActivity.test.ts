/**
 * The history-row builder.
 *
 * `horizonActivity.ts` decides what every row in the history says — sent or
 * received, which asset, how much — and whether two legs are really one swap.
 * Every bug in its comments was a row that lied to the user: a USDC movement
 * labelled XLM, a swap shown as two unrelated transfers, a confirmed spend that
 * never appeared. These tests pin the behaviour that replaced them.
 *
 * Horizon's operations feed and Soroban RPC's event store are both mocked.
 * Nothing here touches the network, and every address is generated in the
 * test — the wallet this code serves holds real money.
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
import { assetFromTopic, invocationToRecord, loadHorizonActivity } from '../horizonActivity';

const mockGetFeePayerAddress = getFeePayerAddress as unknown as jest.Mock;
const MockHorizonServer = Horizon.Server as unknown as jest.Mock;
const MockRpcServer = rpc.Server as unknown as jest.Mock;

/** A random classic (G...) account. Never a real one. */
function randomAccount(): string {
  return Keypair.random().publicKey();
}

/** A random contract (C...) address derived from a random keypair. */
function randomContract(): string {
  return StrKey.encodeContract(StrKey.decodeEd25519PublicKey(Keypair.random().publicKey()));
}

/** The ScVal a Stellar Asset Contract puts in a transfer event's topic slot. */
function sacAddress(address: string): xdr.ScVal {
  return xdr.ScVal.scvAddress(new Address(address).toScAddress());
}

function i128(amount: number): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Int64.fromString(String(amount)) }),
  );
}

let horizonCall: jest.Mock;
let rpcGetLatestLedger: jest.Mock;
let rpcGetEvents: jest.Mock;

beforeEach(() => {
  horizonCall = jest.fn();
  MockHorizonServer.mockImplementation(() => ({
    operations: () => ({
      forAccount: () => ({ order: () => ({ limit: () => ({ call: horizonCall }) }) }),
    }),
  }));

  rpcGetLatestLedger = jest.fn().mockResolvedValue({ sequence: 5_000_000 });
  rpcGetEvents = jest.fn().mockResolvedValue({ events: [] });
  MockRpcServer.mockImplementation(() => ({
    getLatestLedger: rpcGetLatestLedger,
    getEvents: rpcGetEvents,
  }));

  mockGetFeePayerAddress.mockReset();
  mockGetFeePayerAddress.mockResolvedValue(null);
});

// ── assetFromTopic ──────────────────────────────────────────────────────────

describe('assetFromTopic', () => {
  it('reads the native SAC symbol as XLM', () => {
    expect(assetFromTopic(xdr.ScVal.scvSymbol('native'))).toBe('XLM');
  });

  // Known gap, documented rather than approved: the topic carries both the
  // code and the issuer, but only the code is kept. A token called USDC from
  // any issuer therefore shows up in history as "USDC".
  it('documents known gap: shows only the code of CODE:ISSUER, so a USDC token from any issuer displays as USDC', () => {
    const issuer = randomAccount();
    expect(assetFromTopic(xdr.ScVal.scvSymbol(`USDC:${issuer}`))).toBe('USDC');
  });

  it('falls back to XLM when the topic is absent, as older events look', () => {
    expect(assetFromTopic(undefined)).toBe('XLM');
  });

  it('falls back to XLM when the topic cannot be decoded', () => {
    expect(assetFromTopic({} as never)).toBe('XLM');
  });
});

// ── invocationToRecord ──────────────────────────────────────────────────────

describe('invocationToRecord', () => {
  const base = { id: 'op-1', timestamp: 1_760_000_000, hash: 'a1b2c3' };

  it('turns a spend into a sent row carrying the moved asset', () => {
    const contract = randomContract();
    const feePayer = randomAccount();
    const recipient = randomAccount();
    const row = invocationToRecord(
      [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', from: contract, to: recipient, amount: '25.0000000' }],
      new Set([contract, feePayer]),
      base,
    );
    expect(row).toEqual({ ...base, type: 'sent', amount: '25', asset: 'USDC', counterparty: recipient });
  });

  it('turns a receipt into a received row', () => {
    const contract = randomContract();
    const sender = randomAccount();
    const row = invocationToRecord(
      [{ asset_type: 'native', from: sender, to: contract, amount: '2.5000000' }],
      new Set([contract]),
      base,
    );
    expect(row).toEqual({ ...base, type: 'received', amount: '2.5', asset: 'XLM', counterparty: sender });
  });

  it('collapses a swap with router hops in between into one swapped row', () => {
    const contract = randomContract();
    const routerA = randomContract();
    const routerB = randomContract();
    const row = invocationToRecord(
      [
        // We send XLM to the router.
        { asset_type: 'native', from: contract, to: routerA, amount: '10.0000000' },
        // The router hops between its own pools — none of our business.
        { asset_type: 'native', from: routerA, to: routerB, amount: '9.9000000' },
        // We receive USDC back from the router.
        { asset_type: 'credit_alphanum4', asset_code: 'USDC', from: routerB, to: contract, amount: '4.2500000' },
      ],
      new Set([contract]),
      base,
    );
    expect(row).toMatchObject({
      type: 'swapped',
      amount: '10',
      asset: 'XLM',
      counterparty: routerB,
      destAmount: '4.25',
      destAsset: 'USDC',
    });
  });

  it('returns null when nothing of ours moved', () => {
    const routerA = randomContract();
    const routerB = randomContract();
    const row = invocationToRecord(
      [{ asset_type: 'native', from: routerA, to: routerB, amount: '1.0000000' }],
      new Set([randomContract()]),
      base,
    );
    expect(row).toBeNull();
  });

  it('ignores a leg between two of our own addresses', () => {
    const contract = randomContract();
    const feePayer = randomAccount();
    const sender = randomAccount();
    const row = invocationToRecord(
      [
        // Moving funds between our own contract and our own fee payer is not a
        // payment to anybody.
        { asset_type: 'native', from: contract, to: feePayer, amount: '3.0000000' },
        { asset_type: 'native', from: sender, to: contract, amount: '1.0000000' },
      ],
      new Set([contract, feePayer]),
      base,
    );
    expect(row).toMatchObject({ type: 'received', amount: '1', counterparty: sender });
  });
});

// ── Classic Horizon operations, through loadHorizonActivity ─────────────────

describe('classic operations', () => {
  it('maps a payment in both directions', async () => {
    const me = randomAccount();
    const other = randomAccount();
    horizonCall.mockResolvedValueOnce({
      records: [
        {
          id: 'op-out',
          type: 'payment',
          transaction_hash: 'hash-out',
          created_at: '2026-01-01T00:00:00Z',
          asset_type: 'native',
          amount: '10.0000000',
          from: me,
          to: other,
        },
      ],
    });
    const [sent] = await loadHorizonActivity(me, 10);
    expect(sent).toMatchObject({
      id: 'op-out',
      type: 'sent',
      amount: '10',
      asset: 'XLM',
      counterparty: other,
      hash: 'hash-out',
    });

    horizonCall.mockResolvedValueOnce({
      records: [
        {
          id: 'op-in',
          type: 'payment',
          transaction_hash: 'hash-in',
          created_at: '2026-01-02T00:00:00Z',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          amount: '12.0000000',
          from: other,
          to: me,
        },
      ],
    });
    const [received] = await loadHorizonActivity(me, 10);
    expect(received).toMatchObject({
      id: 'op-in',
      type: 'received',
      amount: '12',
      asset: 'USDC',
      counterparty: other,
    });
  });

  it('maps create_account in both directions', async () => {
    const me = randomAccount();
    const other = randomAccount();
    horizonCall.mockResolvedValueOnce({
      records: [
        {
          id: 'op-create-out',
          type: 'create_account',
          transaction_hash: 'hash-create-out',
          created_at: '2026-01-01T00:00:00Z',
          funder: me,
          account: other,
          starting_balance: '5.0000000',
        },
      ],
    });
    const [sent] = await loadHorizonActivity(me, 10);
    expect(sent).toMatchObject({
      type: 'sent',
      amount: '5',
      asset: 'XLM',
      counterparty: other,
    });

    horizonCall.mockResolvedValueOnce({
      records: [
        {
          id: 'op-create-in',
          type: 'create_account',
          transaction_hash: 'hash-create-in',
          created_at: '2026-01-02T00:00:00Z',
          funder: other,
          account: me,
          starting_balance: '7.0000000',
        },
      ],
    });
    const [received] = await loadHorizonActivity(me, 10);
    expect(received).toMatchObject({
      type: 'received',
      amount: '7',
      asset: 'XLM',
      counterparty: other,
    });
  });

  // Known gap, documented rather than approved: on a received path payment
  // the row shows the sender's source amount, not the amount that reached us.
  it.each(['path_payment_strict_send', 'path_payment_strict_receive'])(
    'documents known gap: maps %s in both directions as a swap, so a received row shows the sender\'s source amount',
    async (type) => {
      const me = randomAccount();
      const other = randomAccount();
      const base = {
        type,
        created_at: '2026-01-01T00:00:00Z',
        source_asset_type: 'native',
        source_amount: '10.0000000',
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        amount: '4.0000000',
      };

      horizonCall.mockResolvedValueOnce({
        records: [{ ...base, id: 'op-path-out', transaction_hash: 'hash-path-out', from: me, to: other }],
      });
      const [sent] = await loadHorizonActivity(me, 10);
      expect(sent).toMatchObject({
        type: 'swapped',
        amount: '10',
        asset: 'XLM',
        counterparty: other,
        destAmount: '4',
        destAsset: 'USDC',
      });

      horizonCall.mockResolvedValueOnce({
        records: [{ ...base, id: 'op-path-in', transaction_hash: 'hash-path-in', from: other, to: me }],
      });
      const [received] = await loadHorizonActivity(me, 10);
      expect(received).toMatchObject({
        type: 'swapped',
        amount: '10',
        asset: 'XLM',
        counterparty: other,
        destAmount: '4',
        destAsset: 'USDC',
      });
    },
  );

  it('returns an empty list instead of throwing when Horizon fails', async () => {
    horizonCall.mockRejectedValue(new Error('Horizon is down'));
    await expect(loadHorizonActivity(randomAccount(), 10)).resolves.toEqual([]);
  });
});

// ── Smart wallet: two sources describing one transaction ────────────────────

describe('smart wallet sources', () => {
  it('keeps the Horizon row when both sources describe the same transaction', async () => {
    const contract = randomContract();
    const feePayer = randomAccount();
    const router = randomContract();
    const hash = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    mockGetFeePayerAddress.mockResolvedValue(feePayer);

    // Horizon: the invocation carries the full swap, so it is the richer row.
    horizonCall.mockResolvedValue({
      records: [
        {
          id: 'horizon-op-1',
          type: 'invoke_host_function',
          transaction_hash: hash,
          created_at: '2026-01-01T00:00:00Z',
          asset_balance_changes: [
            { asset_type: 'native', from: feePayer, to: router, amount: '10.0000000' },
            { asset_type: 'credit_alphanum4', asset_code: 'USDC', from: router, to: contract, amount: '4.0000000' },
          ],
        },
      ],
    });

    // RPC: the same transaction's SAC transfer event, which knows only one leg.
    rpcGetEvents.mockResolvedValue({
      events: [
        {
          id: 'event-1',
          txHash: hash,
          topic: [
            xdr.ScVal.scvSymbol('transfer'),
            sacAddress(feePayer),
            sacAddress(router),
            xdr.ScVal.scvSymbol('native'),
          ],
          value: i128(100_000_000),
          ledgerClosedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const rows = await loadHorizonActivity(contract, 20);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'horizon-op-1', type: 'swapped', asset: 'XLM', destAsset: 'USDC' });
  });
});
