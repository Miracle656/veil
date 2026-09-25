/**
 * Tests for mobile Privacy settings options (Issue #830).
 *
 * Verifies:
 * 1. Options read the privacy feature flag through `lib/privacy/config.ts`.
 * 2. Unconditional lockout on mainnet: nothing is toggleable, features are disabled.
 * 3. Unavailable options (such as crash reporting on mobile) are clearly labelled
 *    and not faked with non-functional toggles.
 * 4. Distinct status messages for testnet preview vs. mainnet.
 */

import { getPrivacyOptions } from '../privacySettings';
import * as privacyConfig from '../privacy/config';

describe('getPrivacyOptions', () => {
  const originalEnv = process.env['EXPO_PUBLIC_PRIVACY_FEATURE_FLAG'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['EXPO_PUBLIC_PRIVACY_FEATURE_FLAG'] = originalEnv;
    } else {
      delete process.env['EXPO_PUBLIC_PRIVACY_FEATURE_FLAG'];
    }
    jest.restoreAllMocks();
  });

  describe('Mainnet lockout', () => {
    it('locks out Stellar Private Payments unconditionally on mainnet', () => {
      // Even if build flag is enabled, mainnet must lockout
      process.env['EXPO_PUBLIC_PRIVACY_FEATURE_FLAG'] = '1';

      const options = getPrivacyOptions('mainnet');
      const sppOption = options.find((o) => o.key === 'stellar_private_payments');

      expect(sppOption).toBeDefined();
      expect(sppOption?.available).toBe(false);
      expect(sppOption?.toggleable).toBe(false);
      expect(sppOption?.statusLabel).toBe('Locked out on mainnet');
      expect(sppOption?.unavailableReason).toMatch(/testnet-only preview and unconditionally locked out on mainnet/i);
    });

    it('ensures no option is toggleable on mainnet', () => {
      const options = getPrivacyOptions('mainnet');

      for (const opt of options) {
        expect(opt.toggleable).toBe(false);
      }
    });
  });

  describe('Unavailable features transparency', () => {
    it('labels crash reporting as unavailable on mobile without hiding or faking it', () => {
      const options = getPrivacyOptions('testnet');
      const crashOpt = options.find((o) => o.key === 'crash_reporting');

      expect(crashOpt).toBeDefined();
      expect(crashOpt?.available).toBe(false);
      expect(crashOpt?.toggleable).toBe(false);
      expect(crashOpt?.statusLabel).toBe('Unavailable on mobile');
      expect(crashOpt?.unavailableReason).toBeDefined();
    });
  });

  describe('Shared config consumption', () => {
    it('delegates to isPrivacyEnabled from lib/privacy/config', () => {
      const spy = jest.spyOn(privacyConfig, 'isPrivacyEnabled');

      getPrivacyOptions('testnet');
      expect(spy).toHaveBeenCalledWith('testnet');
    });

    it('enables SPP on testnet when the privacy flag is active', () => {
      process.env['EXPO_PUBLIC_PRIVACY_FEATURE_FLAG'] = '1';

      const options = getPrivacyOptions('testnet');
      const sppOption = options.find((o) => o.key === 'stellar_private_payments');

      expect(sppOption?.available).toBe(true);
      expect(sppOption?.toggleable).toBe(true);
      expect(sppOption?.statusLabel).toBe('Enabled (Testnet preview)');
      expect(sppOption?.unavailableReason).toBeUndefined();
    });

    it('disables SPP on testnet when the privacy flag is off', () => {
      delete process.env['EXPO_PUBLIC_PRIVACY_FEATURE_FLAG'];

      const options = getPrivacyOptions('testnet');
      const sppOption = options.find((o) => o.key === 'stellar_private_payments');

      expect(sppOption?.available).toBe(false);
      expect(sppOption?.toggleable).toBe(true);
      expect(sppOption?.statusLabel).toBe('Disabled (Preview flag off)');
      expect(sppOption?.unavailableReason).toMatch(/EXPO_PUBLIC_PRIVACY_FEATURE_FLAG is disabled/i);
    });
  });
});
