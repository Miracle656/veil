import {
  getAssetControlDisclosure,
  USDT0_MAINNET_ISSUER,
  isRegisteredIssuer,
} from '../assets';

/**
 * What Veil tells a holder about the issuer's power over their balance.
 *
 * The wording is deliberately identical to the web wallet's
 * `getAssetControlDisclosure`. Two wallets describing the same asset's flags
 * differently is worse than either wording alone, so if one changes this, the
 * parity test between the registries is not enough to catch it — these cases
 * are.
 */
describe('getAssetControlDisclosure', () => {
  it('says nothing when the issuer can do neither', () => {
    expect(getAssetControlDisclosure({ auth_revocable: false, auth_clawback_enabled: false })).toBeNull();
  });

  it('names both powers when both are set', () => {
    // This is USDT0's real configuration on mainnet.
    expect(
      getAssetControlDisclosure({ auth_revocable: true, auth_clawback_enabled: true }),
    ).toBe(
      'The issuer can freeze this balance or take it back, and this is a property of the asset, not of Veil.',
    );
  });

  it('distinguishes clawback from freeze', () => {
    expect(getAssetControlDisclosure({ auth_clawback_enabled: true })).toContain('take this balance back');
    expect(getAssetControlDisclosure({ auth_clawback_enabled: true })).not.toContain('freeze');

    expect(getAssetControlDisclosure({ auth_revocable: true })).toContain('freeze this balance');
    expect(getAssetControlDisclosure({ auth_revocable: true })).not.toContain('take it back');
  });

  it('shows nothing when the flags are unknown', () => {
    // Null is "Horizon could not answer", not "the issuer is powerless". The web
    // wallet shipped a bug of this exact shape, where a failed load silently
    // dropped the disclosure and the asset looked safer than it is.
    expect(getAssetControlDisclosure(null)).toBeNull();
    expect(getAssetControlDisclosure(undefined)).toBeNull();
  });

  it('never reassures: every non-null disclosure states a power', () => {
    const all = [
      getAssetControlDisclosure({ auth_revocable: true }),
      getAssetControlDisclosure({ auth_clawback_enabled: true }),
      getAssetControlDisclosure({ auth_revocable: true, auth_clawback_enabled: true }),
    ];
    for (const line of all) {
      expect(line).toBeTruthy();
      expect(line).toMatch(/issuer can/);
      // The disclosure must not read as Veil's doing. The asset is built this way.
      expect(line).toContain('not of Veil');
    }
  });
});

/**
 * The code "USDT0" is shared by eight issuers on mainnet and seven are
 * impostors. The real one publishes no home_domain, so there is no stellar.toml
 * to verify it against — the registry pin is the only thing separating it from
 * the forgeries, which is why it is worth a test of its own.
 */
describe('USDT0 issuer pinning', () => {
  it('accepts only the pinned issuer', () => {
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'mainnet')).toBe(true);
  });

  it('rejects another account claiming the same code', () => {
    expect(
      isRegisteredIssuer('USDT0', 'GDBDGR2UQPZ6AYRGGBPZDHGMUHNMMHBQBHRRKQ3VGBPJ4FLXRQKZVFBD', 'mainnet'),
    ).toBe(false);
  });
});
