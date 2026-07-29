/**
 * Tests for the portfolio parser.
 *
 * `parseHeldAssets` is the pure core of the assets screen: given a set of
 * Horizon balances it must surface every classic asset the wallet holds and
 * nothing else — not native XLM, not liquidity-pool shares — with the code,
 * issuer, and balance the row renders.
 */

import { parseHeldAssets, type HorizonBalanceLike } from '../assets';

const USDC = {
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  balance: '42.5000000',
} satisfies HorizonBalanceLike;

const LONGASSET = {
  asset_type: 'credit_alphanum12',
  asset_code: 'LONGASSET',
  asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  balance: '1.0000000',
} satisfies HorizonBalanceLike;

const NATIVE = { asset_type: 'native', balance: '100.0000000' } satisfies HorizonBalanceLike;

const POOL_SHARE = {
  asset_type: 'liquidity_pool_shares',
  balance: '5.0000000',
} satisfies HorizonBalanceLike;

describe('parseHeldAssets', () => {
  it('keeps classic alphanum4 and alphanum12 assets with code/issuer/balance', () => {
    expect(parseHeldAssets([USDC, LONGASSET])).toEqual([
      { code: 'USDC', issuer: USDC.asset_issuer, balance: '42.5000000', assetType: 'credit_alphanum4' },
      { code: 'LONGASSET', issuer: LONGASSET.asset_issuer, balance: '1.0000000', assetType: 'credit_alphanum12' },
    ]);
  });

  it('excludes native XLM and liquidity-pool shares', () => {
    expect(parseHeldAssets([NATIVE, USDC, POOL_SHARE])).toEqual([
      { code: 'USDC', issuer: USDC.asset_issuer, balance: '42.5000000', assetType: 'credit_alphanum4' },
    ]);
  });

  it('drops malformed credit balances missing a code or issuer', () => {
    const noIssuer = { asset_type: 'credit_alphanum4', asset_code: 'BAD', balance: '1' };
    expect(parseHeldAssets([noIssuer])).toEqual([]);
  });

  it('returns an empty portfolio for an account holding only XLM', () => {
    expect(parseHeldAssets([NATIVE])).toEqual([]);
  });
});
