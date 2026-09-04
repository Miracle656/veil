/**
 * The activity feed's duplicate rules.
 *
 * One payment can reach this feed twice, from two sources with two different
 * ids: the contract's SAC transfer event and the fee-payer's classic Horizon
 * payment. Which of the two wins changes between polls, because the classic leg
 * is indexed a moment after the event — so a feed keyed on row id keeps both
 * and the user sees a single transfer listed twice.
 *
 * The opposite mistake is just as visible: keying on the transaction hash alone
 * collapses a bulk payout, which is one transaction carrying many payments, into
 * a single row.
 */

import {
  appendActivityFeed,
  hydrateActivityFeed,
  subscribeActivityFeed,
  type TxRecord,
} from '../activityFeed';

/** The feed has no getter; subscribing hands back the current snapshot. */
function getActivityFeed(): TxRecord[] {
  let snapshot: TxRecord[] = [];
  const unsubscribe = subscribeActivityFeed((records) => {
    snapshot = records;
  });
  unsubscribe();
  return snapshot;
}

const HASH = 'a1b2c3';

function record(over: Partial<TxRecord> = {}): TxRecord {
  return {
    id: 'op-1',
    type: 'sent',
    amount: '2.0000000',
    asset: 'XLM',
    counterparty: 'GRECIPIENT',
    timestamp: 1_760_000_000,
    hash: HASH,
    ...over,
  };
}

beforeEach(() => hydrateActivityFeed([]));

describe('one movement seen through two sources', () => {
  it('does not list a transfer twice when its id changes between polls', () => {
    // Poll 1: only the contract event exists yet.
    hydrateActivityFeed([record({ id: 'ev-99' })], { merge: true });
    // Poll 2: Horizon has indexed the classic leg, so the same payment comes
    // back under the operation id instead.
    hydrateActivityFeed([record({ id: 'op-4711' })], { merge: true });

    expect(getActivityFeed()).toHaveLength(1);
  });

  it('keeps the fresher read of the movement', () => {
    hydrateActivityFeed([record({ id: 'ev-99', counterparty: 'GRECIPIENT' })], { merge: true });
    hydrateActivityFeed([record({ id: 'op-4711', memo: 'rent' })], { merge: true });

    const [only] = getActivityFeed();
    expect(only.id).toBe('op-4711');
    expect(only.memo).toBe('rent');
  });

  it('applies the same rule when records are appended rather than merged', () => {
    hydrateActivityFeed([record({ id: 'ev-99' })], { merge: true });
    appendActivityFeed([record({ id: 'op-4711' })]);

    expect(getActivityFeed()).toHaveLength(1);
  });
});

describe('genuinely distinct movements', () => {
  it('keeps every payment in a bulk payout, which share one hash', () => {
    hydrateActivityFeed(
      [
        record({ id: 'op-1', counterparty: 'GALICE', amount: '1.0000000' }),
        record({ id: 'op-2', counterparty: 'GBOB', amount: '2.0000000' }),
        record({ id: 'op-3', counterparty: 'GCAROL', amount: '3.0000000' }),
      ],
      { merge: true },
    );

    expect(getActivityFeed()).toHaveLength(3);
  });

  it('keeps two payments to the same person for different amounts', () => {
    hydrateActivityFeed(
      [
        record({ id: 'op-1', amount: '1.0000000' }),
        record({ id: 'op-2', amount: '2.0000000' }),
      ],
      { merge: true },
    );

    expect(getActivityFeed()).toHaveLength(2);
  });

  it('keeps a send and a receive that share a hash', () => {
    hydrateActivityFeed(
      [record({ id: 'op-1', type: 'sent' }), record({ id: 'op-2', type: 'received' })],
      { merge: true },
    );

    expect(getActivityFeed()).toHaveLength(2);
  });

  it('falls back to the row id when a record carries no hash', () => {
    hydrateActivityFeed(
      [record({ id: 'local-1', hash: undefined }), record({ id: 'local-2', hash: undefined })],
      { merge: true },
    );

    expect(getActivityFeed()).toHaveLength(2);
  });
});

describe('replace still wipes', () => {
  it('drops the previous wallet rows so switching wallets does not blend them', () => {
    hydrateActivityFeed([record({ id: 'op-1' })], { merge: true });
    hydrateActivityFeed([]);

    expect(getActivityFeed()).toEqual([]);
  });
});
