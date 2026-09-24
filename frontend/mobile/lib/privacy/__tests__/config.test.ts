/**
 * V131 — privacy feature flag and per-network SPP config
 * (lib/privacy/config.ts), mobile side.
 *
 * The invariants under test: privacy is off by default, and even a build that
 * has the flag on cannot enable it on mainnet, because SPP is a testnet-only
 * developer preview. The config is pinned to the upstream deployments.json
 * values this module was written against, so a drift from an SPP redeploy
 * fails a test instead of silently pointing the app at the wrong pool.
 */

import { getNetworkName } from '../../network';
import { SPP_NETWORKS, getSppConfig, isPrivacyEnabled } from '../config';

const PRIVACY_FLAG_VAR = 'EXPO_PUBLIC_PRIVACY_FEATURE_FLAG';

beforeEach(() => {
  delete process.env[PRIVACY_FLAG_VAR];
});

afterAll(() => {
  delete process.env[PRIVACY_FLAG_VAR];
});

describe('privacy feature flag', () => {
  it('is off by default, even on testnet', () => {
    expect(isPrivacyEnabled('testnet')).toBe(false);
  });

  it('accepts 1 or true as the build-time switch on testnet', () => {
    process.env[PRIVACY_FLAG_VAR] = '1';
    expect(isPrivacyEnabled('testnet')).toBe(true);
    process.env[PRIVACY_FLAG_VAR] = 'true';
    expect(isPrivacyEnabled('testnet')).toBe(true);
  });

  it('cannot be turned on while the network is mainnet', () => {
    process.env[PRIVACY_FLAG_VAR] = 'true';
    expect(isPrivacyEnabled('mainnet')).toBe(false);
  });

  it('defaults to the active network', () => {
    expect(isPrivacyEnabled()).toBe(isPrivacyEnabled(getNetworkName()));
  });
});

describe('per-network SPP config', () => {
  it('has no entry for mainnet', () => {
    expect(SPP_NETWORKS.mainnet).toBeUndefined();
    expect(getSppConfig('mainnet')).toBeNull();
  });

  it('matches the pinned deployments.json contract IDs on testnet', () => {
    expect(getSppConfig('testnet')).toMatchObject({
      aspMembership: 'CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGC',
      aspNonMembership: 'CAFLZKGO3KYKNOBPCVT3APFEWMUBRDBF4EVYK65E6O653WYMX4XH4QYJ',
      publicKeyRegistry: 'CC6EJCBEULJGHNQQROKLXD6M6IKFW6LN7IHTVUEFQQWZDDLCMNPWXIH4',
      bootnodeUrl: 'https://bootnode.dev-nethermind.xyz',
    });
  });

  it('matches the pinned deployments.json verifiers on testnet', () => {
    expect(getSppConfig('testnet')?.verifiers).toEqual({
      standard: 'CD34JHLNB7AYASRLOTMT6EECBKFMOS356PPP5RPXRO5Y5EA5Y4DIXGTV',
      traceable: 'CDBA2ZZSVV5VVE4OL2ORCSG2XDN4CD2UPTZIEO7BI32RKRTPFCUF2FMV',
    });
  });

  it('matches the pinned deployments.json pools on testnet', () => {
    expect(getSppConfig('testnet')?.pools).toEqual([
      {
        id: 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT',
        tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        policyFlags: ['blocklist'],
        assetKind: 'native',
      },
      {
        id: 'CADS665GRBHOMPE7GY5XYTFT2J5JKRZN6ILYMJ5ZO62GU4YPL3PYIN42',
        tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        policyFlags: ['blocklist'],
        assetKind: 'native',
        gvkMode: 'traceable',
      },
    ]);
  });
})