/**
 * Mainnet USDT0 earning availability & issuer-pinning tests.
 *
 * Uses the real `@stellar/stellar-sdk` (`Asset`, `Networks`, `StrKey`) so every
 * hard-coded contract/issuer constant and SAC derivation is verified cryptographically,
 * never stubbed.
 */

import { Asset, Networks, StrKey } from '@stellar/stellar-sdk';

import { USDT0_MAINNET_ISSUER, USDT0_MAINNET_SAC } from '../assets';
import {
  checkEarnAssetParam,
  DEFAULT_BLEND_MAINNET_POOL_ID,
  isPinnedUsdt0,
  unavailableEarnAssets,
  usdt0SacContractId,
  type BlendPool,
} from '../blend';

/** Real impostor USDT0 issuers observed on Stellar mainnet (none is Tether). */
const IMPOSTOR_USDT0_ISSUERS = [
  'GA7GNGYVJHF7LTI6OO4FAD2JEQBIQWRBIZOLEZSJJHMNAY6UUZERU526',
  'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT',
  'GAKSY7RQI4YG3H5J5WRYHB4FDEJ2PAQJ6IN3P47HNG6KGUJJ2YOD7ZP3',
  'GAVRQZHG726XIHZKP3MODI3DOUP7IIQ6CC6OJX4JJD7PXRV4FJ3WE77O',
  'GBL35PWBKAHURS7SMATHXTS5X57BHC23P2B6MOJTDXTDKD7K25QHUSDT',
  'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK',
  'GCOSRHJ32W5OTB4QVQOQPV7SDBC7QF4EPCGB6HILSCDGNTMVY2LIDERV',
  'GDBDGR2U3KVHUGJ5SVALIAPT7FBPSYWD25XTF4JPHTPBKFH2SHOOHZFF',
] as const;

describe('USDT0 Earn availability and issuer pinning', () => {
  it('validates hard-coded mainnet pool and USDT0 issuer with StrKey', () => {
    expect(StrKey.isValidContract(DEFAULT_BLEND_MAINNET_POOL_ID)).toBe(true);
    expect(StrKey.isValidEd25519PublicKey(USDT0_MAINNET_ISSUER)).toBe(true);
  });

  it('derives the mainnet USDT0 SAC id from code:issuer instead of hard-coding it', () => {
    const expectedSac = new Asset('USDT0', USDT0_MAINNET_ISSUER).contractId(Networks.PUBLIC);
    const derived = usdt0SacContractId('mainnet', Networks.PUBLIC);

    expect(derived).toBe(expectedSac);
    expect(derived).toBe(USDT0_MAINNET_SAC);
    expect(StrKey.isValidContract(derived!)).toBe(true);
    expect(usdt0SacContractId('testnet', Networks.TESTNET)).toBeNull();
  });

  it('pins USDT0 strictly by Tether issuer on mainnet and rejects every impostor', () => {
    expect(isPinnedUsdt0('USDT0', USDT0_MAINNET_ISSUER, 'mainnet')).toBe(true);
    expect(isPinnedUsdt0('USDT0', USDT0_MAINNET_ISSUER, 'testnet')).toBe(false);
    expect(isPinnedUsdt0('USDT0', null, 'mainnet')).toBe(false);
    expect(isPinnedUsdt0('USDT0', '', 'mainnet')).toBe(false);
    expect(isPinnedUsdt0('USDT0', 'not-a-valid-key', 'mainnet')).toBe(false);
    expect(isPinnedUsdt0('USDC', USDT0_MAINNET_ISSUER, 'mainnet')).toBe(false);

    for (const impostor of IMPOSTOR_USDT0_ISSUERS) {
      expect(StrKey.isValidEd25519PublicKey(impostor)).toBe(true);
      expect(isPinnedUsdt0('USDT0', impostor, 'mainnet')).toBe(false);
    }
  });

  describe('unavailableEarnAssets', () => {
    const fixedV2WithoutUsdt0: BlendPool[] = [
      {
        id: DEFAULT_BLEND_MAINNET_POOL_ID,
        name: 'Fixed',
        reserves: [
          {
            assetId: Asset.native().contractId(Networks.PUBLIC),
            code: 'XLM',
            supplyApy: 0.001,
            totalSupply: '1000',
          },
          {
            assetId: new Asset(
              'USDC',
              'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
            ).contractId(Networks.PUBLIC),
            code: 'USDC',
            supplyApy: 0.06,
            totalSupply: '2000',
          },
        ],
      },
    ];

    it('reports pinned Tether USDT0 as unavailable on mainnet with reason and holding statement', () => {
      const items = unavailableEarnAssets('mainnet', Networks.PUBLIC, fixedV2WithoutUsdt0);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        code: 'USDT0',
        issuer: USDT0_MAINNET_ISSUER,
        issuerName: 'Tether',
        label: 'USDT0 · Tether (GATI…HN6Q)',
        assetId: new Asset('USDT0', USDT0_MAINNET_ISSUER).contractId(Networks.PUBLIC),
        status: 'Earning not available for this asset yet',
      });
      expect(items[0].reason).toContain('Blend Fixed V2');
      expect(items[0].holdingStatement).toContain('stays in your wallet as USDT0');
    });

    it('does not show USDT0 on testnet', () => {
      expect(unavailableEarnAssets('testnet', Networks.TESTNET, [])).toEqual([]);
    });

    it('still reports unavailable if a pool only carries an impostor USDT0 SAC', () => {
      const impostorSac = new Asset('USDT0', IMPOSTOR_USDT0_ISSUERS[0]).contractId(Networks.PUBLIC);
      const poolsWithImpostor: BlendPool[] = [
        {
          id: DEFAULT_BLEND_MAINNET_POOL_ID,
          name: 'Fixed',
          reserves: [
            {
              assetId: impostorSac,
              code: 'USDC',
              supplyApy: 0.05,
              totalSupply: '100',
            },
          ],
        },
      ];

      const items = unavailableEarnAssets('mainnet', Networks.PUBLIC, poolsWithImpostor);
      expect(items).toHaveLength(1);
      expect(items[0].issuer).toBe(USDT0_MAINNET_ISSUER);
    });

    it('omits the unavailable entry if a pool actually lists Tether pinned USDT0 SAC', () => {
      const pinnedSac = new Asset('USDT0', USDT0_MAINNET_ISSUER).contractId(Networks.PUBLIC);
      const poolsWithPinned: BlendPool[] = [
        {
          id: DEFAULT_BLEND_MAINNET_POOL_ID,
          name: 'Fixed',
          reserves: [
            {
              assetId: pinnedSac,
              code: 'USDC',
              supplyApy: 0.05,
              totalSupply: '100',
            },
          ],
        },
      ];

      expect(unavailableEarnAssets('mainnet', Networks.PUBLIC, poolsWithPinned)).toEqual([]);
    });
  });

  describe('checkEarnAssetParam', () => {
    it('returns unavailable with holding statement for pinned USDT0 on mainnet', () => {
      const result = checkEarnAssetParam('USDT0', USDT0_MAINNET_ISSUER, 'mainnet');
      expect(result.kind).toBe('unavailable');
      if (result.kind === 'unavailable') {
        expect(result.message).toContain('Earning not available');
        expect(result.message).toContain('GATI…HN6Q');
        expect(result.message).toContain('stays in your wallet as USDT0');
      }
    });

    it('refuses every impostor USDT0 issuer as unregistered', () => {
      for (const impostor of IMPOSTOR_USDT0_ISSUERS) {
        const result = checkEarnAssetParam('USDT0', impostor, 'mainnet');
        expect(result.kind).toBe('unregistered-issuer');
        if (result.kind === 'unregistered-issuer') {
          expect(result.message).toContain('Unregistered issuer');
          expect(result.message).toContain('GATI…HN6Q');
        }
      }
    });

    it('rejects malformed USDT0 issuer keys', () => {
      expect(checkEarnAssetParam('USDT0', 'not-a-key', 'mainnet').kind).toBe('invalid-issuer');
    });

    it('marks USDT0 unavailable on testnet', () => {
      const result = checkEarnAssetParam('USDT0', USDT0_MAINNET_ISSUER, 'testnet');
      expect(result).toEqual({
        kind: 'unavailable',
        message: 'USDT0 is not available on testnet.',
      });
    });

    it('passes non-USDT0 assets through', () => {
      expect(
        checkEarnAssetParam(
          'USDC',
          'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          'mainnet'
        )
      ).toEqual({ kind: 'ok' });
    });
  });
});
