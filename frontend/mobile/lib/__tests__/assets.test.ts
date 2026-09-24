/**
 * Tests for the portfolio parser and verified asset registry (including USDT0).
 */

import { Asset, Networks } from '@stellar/stellar-sdk';
import {
  parseHeldAssets,
  type HorizonBalanceLike,
  ASSET_REGISTRY,
  USDT0_MAINNET_ISSUER,
  USDT0_MAINNET_SAC_CONTRACT_ID,
  getRegisteredAsset,
  getAssetIssuer,
  isRegisteredIssuer,
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

describe('USDT0 asset registry on mobile (#787)', () => {
  it('dynamically derives the SAC contract ID from asset and issuer on public network', () => {
    const derivedSac = new Asset('USDT0', USDT0_MAINNET_ISSUER).contractId(Networks.PUBLIC);
    expect(derivedSac).toBe(USDT0_MAINNET_SAC_CONTRACT_ID);
    expect(derivedSac).toBe(ASSET_REGISTRY.USDT0.contractId);
  });

  it('registers USDT0 with the canonical issuer and without a homeDomain', () => {
    const usdt0 = ASSET_REGISTRY.USDT0;
    expect(usdt0).toBeDefined();
    expect(usdt0.code).toBe('USDT0');
    expect(usdt0.issuer).toBe('GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q');
    expect(usdt0.kind).toBe('stablecoin');
    expect(usdt0.network).toBe('mainnet');
    expect(usdt0.homeDomain).toBeUndefined();
  });

  it('offers USDT0 on mainnet only, returning null on testnet', () => {
    expect(getRegisteredAsset('USDT0', 'mainnet')).toBeDefined();
    expect(getRegisteredAsset('USDT0', 'testnet')).toBeNull();

    expect(getAssetIssuer('USDT0', 'mainnet')).toBe(USDT0_MAINNET_ISSUER);
    expect(getAssetIssuer('USDT0', 'testnet')).toBeNull();
  });

  it('verifies genuine USDT0 issuer and rejects impostor issuers', () => {
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'mainnet')).toBe(true);
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'testnet')).toBe(false);

    const impostors = [
      'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK',
      'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT',
      'GBL35PWBKAHURS7SMATHXTS5X57BHC23P2B6MOJTDXTDKD7K25QHUSDT',
      'GAKSY7RQI4YG3H5J5WRYHB4FDEJ2PAQJ6IN3P47HNG6KGUJJ2YOD7ZP3',
    ];

    for (const impostor of impostors) {
      expect(isRegisteredIssuer('USDT0', impostor, 'mainnet')).toBe(false);
    }
  });
});
