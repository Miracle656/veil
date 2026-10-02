/**
 * Tests for the activity-feed mapper.
 *
 * `mapPayments` is the pure core of the dashboard feed: it turns Horizon
 * payment/create_account records into direction-aware rows for a given
 * account, and drops operations that aren't value transfers. Getting the
 * direction and counterparty right is what makes the feed trustworthy.
 */

import { mapPayments, type HorizonPaymentLike } from '../activity';

const ME = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const OTHER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function payment(over: Partial<HorizonPaymentLike>): HorizonPaymentLike {
  return {
    id: '1',
    type: 'payment',
    transaction_hash: 'hashabc',
    created_at: '2026-01-01T00:00:00Z',
    asset_type: 'native',
    amount: '10.0000000',
    ...over,
  };
}

describe('mapPayments', () => {
  it('marks a payment to me as received, from the sender', () => {
    const [row] = mapPayments([payment({ from: OTHER, to: ME })], ME);
    expect(row).toMatchObject({ direction: 'received', counterparty: OTHER, asset: 'XLM', amount: '10.0000000' });
  });

  it('marks a payment from me as sent, to the recipient', () => {
    const [row] = mapPayments([payment({ from: ME, to: OTHER })], ME);
    expect(row).toMatchObject({ direction: 'sent', counterparty: OTHER });
  });

  it('uses the asset code for non-native payments', () => {
    const [row] = mapPayments(
      [payment({ from: OTHER, to: ME, asset_type: 'credit_alphanum4', asset_code: 'USDC' })],
      ME,
    );
    expect(row.asset).toBe('USDC');
  });

  it('maps create_account as a received XLM transfer of the starting balance', () => {
    const [row] = mapPayments(
      [
        {
          id: '2',
          type: 'create_account',
          transaction_hash: 'hashdef',
          created_at: '2026-01-02T00:00:00Z',
          account: ME,
          funder: OTHER,
          starting_balance: '5.0000000',
        },
      ],
      ME,
    );
    expect(row).toMatchObject({ direction: 'received', counterparty: OTHER, asset: 'XLM', amount: '5.0000000' });
  });

  it('drops operations that are not value transfers', () => {
    const other = { id: '3', type: 'change_trust', transaction_hash: 'h', created_at: '2026-01-03T00:00:00Z' };
    expect(mapPayments([other], ME)).toEqual([]);
  });

  it('converts created_at into a unix-seconds timestamp', () => {
    const [row] = mapPayments([payment({ from: OTHER, to: ME, created_at: '2026-01-01T00:00:00Z' })], ME);
    expect(row.timestamp).toBe(Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000));
  });
});
