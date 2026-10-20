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
  USDT0_MAINNET_ISSUER,
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

  it('includes exact registry entries for USDC, XLM, EURC, AQUA, USDY, and USDT0', () => {
    expect(ASSET_REGISTRY.USDC).toBeDefined();
    expect(ASSET_REGISTRY.XLM).toBeDefined();
    expect(ASSET_REGISTRY.EURC).toBeDefined();
    expect(ASSET_REGISTRY.AQUA).toBeDefined();
    expect(ASSET_REGISTRY.USDY).toBeDefined();
    expect(ASSET_REGISTRY.USDT0).toBeDefined();
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

describe('mobile ASSET_REGISTRY - USDT0 (Issue #787)', () => {
  it('USDT0 resolves to exactly the pinned issuer on mainnet', () => {
    const asset = getRegisteredAsset('USDT0');
    expect(asset).not.toBeNull();
    expect(asset?.code).toBe('USDT0');
    expect(asset?.issuer).toBe(USDT0_MAINNET_ISSUER);
    expect(asset?.issuer).toBe('GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q');
    expect(asset?.network).toBe('mainnet');
    expect(asset?.kind).toBe('stablecoin');
    expect(asset?.homeDomain).toBeUndefined();
  });

  it('gating: does not offer USDT0 on testnet, but offers on mainnet', () => {
    expect(getRegisteredAsset('USDT0', 'testnet')).toBeNull();
    expect(getAssetIssuer('USDT0', 'testnet')).toBeNull();
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'testnet')).toBe(false);

    expect(getRegisteredAsset('USDT0', 'mainnet')?.issuer).toBe(USDT0_MAINNET_ISSUER);
    expect(getAssetIssuer('USDT0', 'mainnet')).toBe(USDT0_MAINNET_ISSUER);
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'mainnet')).toBe(true);
  });
});

describe('Hold USDT0 in mobile: trustline, balance and impostor check (Issue #790)', () => {
  const REAL_USDT0_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q';
  const FAKE_USDT0_ISSUER = 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK';

  const WALLET_BALANCES_WITH_REAL_AND_FAKE_USDT0: HorizonBalanceLike[] = [
    { asset_type: 'native', balance: '50.0000000' },
    {
      asset_type: 'credit_alphanum12',
      asset_code: 'USDT0',
      asset_issuer: REAL_USDT0_ISSUER,
      balance: '1234.5678901',
    },
    {
      asset_type: 'credit_alphanum12',
      asset_code: 'USDT0',
      asset_issuer: FAKE_USDT0_ISSUER,
      balance: '9999999.1234567',
    },
  ];

  it('parses portfolio containing both real and fake USDT0 preserving 7 decimal places', () => {
    const held = parseHeldAssets(WALLET_BALANCES_WITH_REAL_AND_FAKE_USDT0);
    expect(held).toHaveLength(2);

    const realAsset = held.find((a) => a.issuer === REAL_USDT0_ISSUER);
    const fakeAsset = held.find((a) => a.issuer === FAKE_USDT0_ISSUER);

    expect(realAsset).toBeDefined();
    expect(realAsset?.code).toBe('USDT0');
    expect(realAsset?.balance).toBe('1234.5678901');

    expect(fakeAsset).toBeDefined();
    expect(fakeAsset?.code).toBe('USDT0');
    expect(fakeAsset?.balance).toBe('9999999.1234567');
  });

  it('identifies genuine USDT0 and does not treat fake USDT0 as registered asset', () => {
    expect(isRegisteredIssuer('USDT0', REAL_USDT0_ISSUER, 'mainnet')).toBe(true);
    expect(isRegisteredIssuer('USDT0', FAKE_USDT0_ISSUER, 'mainnet')).toBe(false);

    const reg = getRegisteredAsset('USDT0', 'mainnet');
    expect(reg?.issuer).toBe(REAL_USDT0_ISSUER);
    expect(reg?.issuerName).toBe('Tether');
  });
});

