import {
  enableTrustline,
  enableUsdc,
  enableUsdy,
  NotEnoughXlm,
  AccountNotFunded,
  MissingTrustline,
  MIN_XLM_FOR_TRUSTLINE,
} from '../enableUsdc';
import { USDY_MAINNET_ISSUER, getRegisteredAsset, isRegisteredIssuer } from '../assets';

describe('Asset Registry for USDY & USDC', () => {
  it('verifies USDY issuer against the registry (GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6)', () => {
    const usdy = getRegisteredAsset('USDY');
    expect(usdy).not.toBeNull();
    expect(usdy?.code).toBe('USDY');
    expect(usdy?.issuer).toBe(USDY_MAINNET_ISSUER);
    expect(usdy?.homeDomain).toBe('ondo.finance');
    expect(isRegisteredIssuer('USDY', USDY_MAINNET_ISSUER)).toBe(true);
    expect(isRegisteredIssuer('USDY', 'GFAKEISSUER1234567890123456789012345678901234567890123456')).toBe(false);
  });
});

describe('NotEnoughXlm & MissingTrustline Error Classes', () => {
  it('formats NotEnoughXlm error with plain sentence including asset code and required reserve', () => {
    const err = new NotEnoughXlm(0.3, 'USDY');
    expect(err.name).toBe('NotEnoughXlm');
    expect(err.message).toBe(
      `This account holds 0.3 XLM. Adding a USDY trustline needs about ${MIN_XLM_FOR_TRUSTLINE} XLM of refundable reserve.`,
    );
  });

  it('formats MissingTrustline error with plain sentence stating 0.5 XLM reserve', () => {
    const err = new MissingTrustline('USDY');
    expect(err.name).toBe('MissingTrustline');
    expect(err.message).toBe(
      'You need to enable USDY to hold it. Adding a trustline requires 0.5 XLM of refundable reserve.',
    );
  });

  it('formats AccountNotFunded error with plain sentence', () => {
    const err = new AccountNotFunded();
    expect(err.name).toBe('AccountNotFunded');
    expect(err.message).toBe(
      'This account does not exist on the network yet, so it cannot add a trustline.',
    );
  });
});
