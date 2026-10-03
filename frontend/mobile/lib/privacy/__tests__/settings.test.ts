/**
 * #830 — the mobile privacy settings options (lib/privacy/settings.ts).
 */

import * as config from '../config';
import { getPrivacySettingsOptions } from '../settings';

const PRIVACY_FLAG_VAR = 'EXPO_PUBLIC_PRIVACY_FEATURE_FLAG';

beforeEach(() => {
  delete process.env[PRIVACY_FLAG_VAR];
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  delete process.env[PRIVACY_FLAG_VAR];
});

function option(key: string, options = getPrivacySettingsOptions('testnet')) {
  const found = options.find((o) => o.key === key);
  if (!found) throw new Error(`no ${key} option`);
  return found;
}

describe('mainnet lockout', () => {
  it('leaves nothing toggleable on mainnet, even with the build flag on', () => {
    process.env[PRIVACY_FLAG_VAR] = 'true';
    const options = getPrivacySettingsOptions('mainnet');
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(o.toggleable).toBe(false);
  });

  it('labels private payments as unavailable on mainnet rather than hiding it', () => {
    process.env[PRIVACY_FLAG_VAR] = '1';
    const payments = option('private-payments', getPrivacySettingsOptions('mainnet'));
    expect(payments.status).toBe('unavailable-network');
    expect(payments.statusLabel).toBe('Not available on mainnet');
    expect(payments.statusDetail).toMatch(/not approved for mainnet/);
  });
});

describe('reads the shared config', () => {
  it('asks lib/privacy/config.ts for the flag with the given network', () => {
    const spy = jest.spyOn(config, 'isPrivacyEnabled');
    getPrivacySettingsOptions('mainnet');
    expect(spy).toHaveBeenCalledWith('mainnet');
  });

  it('follows the shared flag rather than a local copy', () => {
    jest.spyOn(config, 'isPrivacyEnabled').mockReturnValue(true);
    expect(option('private-payments').status).toBe('unavailable-mobile');
    jest.spyOn(config, 'isPrivacyEnabled').mockReturnValue(false);
    expect(option('private-payments').status).toBe('disabled-build');
  });
});

describe('testnet', () => {
  it('says the build has not enabled private payments when the flag is off', () => {
    const payments = option('private-payments');
    expect(payments.status).toBe('disabled-build');
    expect(payments.statusLabel).toBe('Off in this build');
    expect(payments.toggleable).toBe(false);
  });

  it('labels private payments as not yet on mobile when the flag is on', () => {
    process.env[PRIVACY_FLAG_VAR] = 'true';
    const payments = option('private-payments');
    expect(payments.status).toBe('unavailable-mobile');
    expect(payments.statusLabel).toBe('Not yet available on mobile');
    expect(payments.statusDetail).toContain(config.getPolicyMetadata().name);
    // Mobile has no shielded-transfer flow yet, so no control may be offered.
    expect(payments.toggleable).toBe(false);
  });
});

describe('crash reports', () => {
  it.each(['testnet', 'mainnet'] as const)('is listed but labelled unavailable on %s', (network) => {
    const reports = option('crash-reports', getPrivacySettingsOptions(network));
    expect(reports.status).toBe('unavailable-mobile');
    expect(reports.statusLabel).toBe('Not yet available on mobile');
    expect(reports.toggleable).toBe(false);
  });
});

it('mirrors the web screen: private payments and error reporting, in that order', () => {
  expect(getPrivacySettingsOptions('testnet').map((o) => o.key)).toEqual([
    'private-payments',
    'crash-reports',
  ]);
});
