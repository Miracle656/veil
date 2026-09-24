/**
 * Tests for the portfolio parser and verified asset registry.
 */

import {
  ASSET_REGISTRY,
  formatAssetLabel,
  getAssetIssuer,
  getRegisteredAsset,
  isRegisteredIssuer,
  parseHeldAssets,
  type HorizonBalanceLike,
} from '../assets';

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

describe('Verified Asset Registry (Mobile)', () => {
  const LOOKALIKE_ISSUER = 'GFAKE123456789012345678901234567890123456789012345678901';

  it('includes exact registry entries for USDC, XLM, EURC, AQUA, and USDY', () => {
    expect(ASSET_REGISTRY.USDC).toBeDefined();
    expect(ASSET_REGISTRY.XLM).toBeDefined();
    expect(ASSET_REGISTRY.EURC).toBeDefined();
    expect(ASSET_REGISTRY.AQUA).toBeDefined();
    expect(ASSET_REGISTRY.USDY).toBeDefined();
  });

  it('resolves XLM correctly without an issuer field', () => {
    const xlmAsset = getRegisteredAsset('XLM');
    expect(xlmAsset).not.toBeNull();
    expect(xlmAsset?.code).toBe('XLM');
    expect(xlmAsset?.issuer).toBe('');

    expect(getRegisteredAsset('XLM', '')).toEqual(xlmAsset);
    expect(getRegisteredAsset('XLM', null)).toEqual(xlmAsset);
    expect(formatAssetLabel('XLM')).toBe('XLM');
    expect(formatAssetLabel('XLM', '')).toBe('XLM');
  });

  it('labels lookalike issuers (different G... address, same code) as unverified', () => {
    const usdyLookalike = getRegisteredAsset('USDY', LOOKALIKE_ISSUER);
    expect(usdyLookalike).toBeNull();

    const formattedLabel = formatAssetLabel('USDY', LOOKALIKE_ISSUER);
    expect(formattedLabel).toBe('Unverified: USDY (issuer GFAK…)');

    const isRegistered = isRegisteredIssuer('USDY', LOOKALIKE_ISSUER);
    expect(isRegistered).toBe(false);
  });

  it('labels lookalike EURC issuers as unverified', () => {
    const eurcLookalike = getRegisteredAsset('EURC', LOOKALIKE_ISSUER);
    expect(eurcLookalike).toBeNull();
    expect(formatAssetLabel('EURC', LOOKALIKE_ISSUER)).toBe('Unverified: EURC (issuer GFAK…)');
  });

  it('resolves legitimate assets when exact code and issuer match', () => {
    const usdyIssuer = ASSET_REGISTRY.USDY.issuer;
    expect(getRegisteredAsset('USDY', usdyIssuer)).not.toBeNull();
    expect(formatAssetLabel('USDY', usdyIssuer)).toBe('USDY');
    expect(isRegisteredIssuer('USDY', usdyIssuer)).toBe(true);
  });
});
