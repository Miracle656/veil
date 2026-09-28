/**
 * #792 — the mobile asset registry must be the web wallet's, entry for entry.
 *
 * `frontend/mobile/lib/assets.ts` is a hand-maintained copy of
 * `frontend/wallet/lib/assets.ts`. An asset added, re-pointed or dropped on one
 * side only is a divergence, and for an asset like USDT0 — eight issuers, seven
 * of them impostors — a divergence is a security bug: one client would accept
 * an issuer the other refuses.
 *
 * If this fails, you edited one registry alone. Make the same change in both
 * `lib/assets.ts` files. Do not "fix" it here.
 *
 * The wallet mirrors this file (`frontend/wallet/lib/__tests__/registryParity.test.ts`)
 * so an edit to either side fails in that side's own test run too.
 */

import { Asset, Networks } from '@stellar/stellar-sdk';

import * as mobile from '../assets';
import * as wallet from '../../../wallet/lib/assets';

const NETWORKS = ['mainnet', 'testnet'] as const;

/** From mainnet Horizon, 2026-09-24 (#792). */
const USDT0_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q';
const USDT0_SAC = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF';
const USDT0_IMPOSTORS = [
  'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK',
  'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT',
  'GBL35PWBKAHURS7SMATHXTS5X57BHC23P2B6MOJTDXTDKD7K25QHUSDT',
  'GAKSY7RQI4YG3H5J5WRYHB4FDEJ2PAQJ6IN3P47HNG6KGUJJ2YOD7ZP3',
  'GA7GNGYVJHF7LTI6OO4FAD2JEQBIQWRBIZOLEZSJJHMNAY6UUZERU526',
  'GAVRQZHG726XIHZKP3MODI3DOUP7IIQ6CC6OJX4JJD7PXRV4FJ3WE77O',
  'GDBDGR2U3KVHUGJ5SVALIAPT7FBPSYWD25XTF4JPHTPBKFH2SHOOHZFF',
];

const codes = [...new Set([...Object.keys(mobile.ASSET_REGISTRY), ...Object.keys(wallet.ASSET_REGISTRY)])].sort();

describe('mobile and wallet asset registries are identical — edit both lib/assets.ts together', () => {
  it('list the same assets', () => {
    expect(Object.keys(mobile.ASSET_REGISTRY).sort()).toEqual(Object.keys(wallet.ASSET_REGISTRY).sort());
  });

  it.each(codes)('hold the same %s entry, field for field', (code) => {
    expect(mobile.ASSET_REGISTRY[code]).toEqual(wallet.ASSET_REGISTRY[code]);
  });

  it('export the same pinned issuers and SAC', () => {
    expect(mobile.USDY_MAINNET_ISSUER).toBe(wallet.USDY_MAINNET_ISSUER);
    expect(mobile.USDT0_MAINNET_ISSUER).toBe(wallet.USDT0_MAINNET_ISSUER);
    expect(mobile.USDT0_MAINNET_SAC).toBe(wallet.USDT0_MAINNET_SAC);
  });

  // The lookups carry hand-written special cases (testnet USDC), so the data
  // matching is not enough: they must also answer the same questions alike.
  describe.each(NETWORKS)('answer the same lookups on %s', (network) => {
    it.each(codes)('%s', (code) => {
      expect(mobile.getRegisteredAsset(code, network)).toEqual(wallet.getRegisteredAsset(code, network));
      const issuer = wallet.getAssetIssuer(code, network);
      expect(mobile.getAssetIssuer(code, network)).toBe(issuer);
      if (issuer) {
        expect(mobile.isRegisteredIssuer(code, issuer, network)).toBe(wallet.isRegisteredIssuer(code, issuer, network));
      }
    });
  });
});

describe('USDT0 is pinned to its one genuine issuer on both sides', () => {
  it.each([
    ['mobile', mobile],
    ['wallet', wallet],
  ] as const)('%s', (_side, registry) => {
    const entry = registry.ASSET_REGISTRY['USDT0'];
    expect(entry).toMatchObject({ code: 'USDT0', issuer: USDT0_ISSUER, network: 'mainnet' });
    // The genuine issuer publishes no stellar.toml; every impostor does.
    expect(entry?.homeDomain).toBeUndefined();

    // Derived, not pasted — then checked against Horizon.
    const derived = new Asset('USDT0', USDT0_ISSUER).contractId(Networks.PUBLIC);
    expect(derived).toBe(USDT0_SAC);
    expect(entry?.sacContractId).toBe(derived);

    expect(registry.isRegisteredIssuer('USDT0', USDT0_ISSUER, 'mainnet')).toBe(true);
    expect(registry.isRegisteredIssuer('USDT0', USDT0_ISSUER, 'testnet')).toBe(false);
    for (const impostor of USDT0_IMPOSTORS) {
      expect(registry.isRegisteredIssuer('USDT0', impostor, 'mainnet')).toBe(false);
    }
  });
});

describe('mobile only badges an asset whose code and issuer both match', () => {
  it('verifies the genuine USDT0 and nothing that merely shares its code', () => {
    expect(mobile.verifiedAsset('USDT0', USDT0_ISSUER, 'mainnet')?.issuerName).toBe('Tether');
    for (const impostor of USDT0_IMPOSTORS) {
      expect(mobile.verifiedAsset('USDT0', impostor, 'mainnet')).toBeNull();
    }
    expect(mobile.verifiedAsset('usdt0', USDT0_ISSUER, 'mainnet')).toBeNull();
    expect(mobile.verifiedAsset('USDT0', USDT0_ISSUER, 'testnet')).toBeNull();
    expect(mobile.verifiedAsset('USDT0', null, 'mainnet')).toBeNull();
  });
});
