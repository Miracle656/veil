/**
 * Tests for the token-detail helpers.
 *
 * `parseAssetId` turns a route segment back into an asset, and
 * `filterTokenActivity` narrows a payment page down to just the operations
 * that touch that asset — the two pure pieces the detail screen relies on.
 */

import { parseAssetId, filterTokenActivity, type HorizonPaymentLike } from '../token';

const ME = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const OTHER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('parseAssetId', () => {
  it('treats XLM as native (no issuer)', () => {
    expect(parseAssetId('XLM')).toEqual({ code: 'XLM', issuer: null });
  });

  it('splits CODE:ISSUER', () => {
    expect(parseAssetId(`USDC:${USDC_ISSUER}`)).toEqual({ code: 'USDC', issuer: USDC_ISSUER });
  });

  it('decodes a percent-encoded id', () => {
    expect(parseAssetId(encodeURIComponent(`USDC:${USDC_ISSUER}`))).toEqual({
      code: 'USDC',
      issuer: USDC_ISSUER,
    });
  });
});

describe('filterTokenActivity', () => {
  const xlmIn: HorizonPaymentLike = {
    id: '1', type: 'payment', transaction_hash: 'h1', created_at: '2026-01-01T00:00:00Z',
    from: OTHER, to: ME, amount: '10.0000000', asset_type: 'native',
  };
  const usdcOut: HorizonPaymentLike = {
    id: '2', type: 'payment', transaction_hash: 'h2', created_at: '2026-01-02T00:00:00Z',
    from: ME, to: OTHER, amount: '3.0000000', asset_type: 'credit_alphanum4',
    asset_code: 'USDC', asset_issuer: USDC_ISSUER,
  };
  const funding: HorizonPaymentLike = {
    id: '3', type: 'create_account', transaction_hash: 'h3', created_at: '2026-01-03T00:00:00Z',
    account: ME, funder: OTHER, starting_balance: '5.0000000',
  };

  it('keeps only XLM payments (and funding) for the native asset', () => {
    const rows = filterTokenActivity([xlmIn, usdcOut, funding], ME, 'XLM', null);
    expect(rows.map((r) => r.id)).toEqual(['1', '3']);
    expect(rows[0]).toMatchObject({ direction: 'received', counterparty: OTHER });
    expect(rows[1]).toMatchObject({ direction: 'received', amount: '5.0000000' });
  });

  it('keeps only the matching credit asset and honours the issuer', () => {
    const rows = filterTokenActivity([xlmIn, usdcOut, funding], ME, 'USDC', USDC_ISSUER);
    expect(rows.map((r) => r.id)).toEqual(['2']);
    expect(rows[0]).toMatchObject({ direction: 'sent', counterparty: OTHER });
  });

  it('excludes a same-code asset from a different issuer', () => {
    const rows = filterTokenActivity([usdcOut], ME, 'USDC', OTHER);
    expect(rows).toEqual([]);
  });
});
