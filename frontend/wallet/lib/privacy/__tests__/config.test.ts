/**
 * @jest-environment jsdom
 *
 * V131 & V132 — privacy feature flag, per-network SPP config, and
 * association-set policy configuration (lib/privacy/config.ts).
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

// jsdom provides neither WebCrypto nor these encoders; @stellar/stellar-sdk —
// pulled in transitively by lib/network.ts — needs them at import time.
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { getNetworkName } from '../../network'
import {
  SPP_NETWORKS,
  getSppConfig,
  isPrivacyEnabled,
  DEFAULT_ASSOCIATION_SET_POLICY,
  getAssociationSetPolicy,
  getAssociationSetContract,
  getPolicyMetadata,
  isPolicyRejectionError,
  formatPrivacyError,
} from '../config'

const PRIVACY_FLAG_VAR = 'NEXT_PUBLIC_PRIVACY_FEATURE_FLAG'
const ASP_POLICY_VAR = 'NEXT_PUBLIC_PRIVACY_ASP_POLICY'

beforeEach(() => {
  delete process.env[PRIVACY_FLAG_VAR]
  delete process.env[ASP_POLICY_VAR]
})

afterAll(() => {
  delete process.env[PRIVACY_FLAG_VAR]
  delete process.env[ASP_POLICY_VAR]
})

describe('privacy feature flag', () => {
  it('is off by default, even on testnet', () => {
    expect(isPrivacyEnabled('testnet')).toBe(false)
  })

  it('accepts 1 or true as the build-time switch on testnet', () => {
    process.env[PRIVACY_FLAG_VAR] = '1'
    expect(isPrivacyEnabled('testnet')).toBe(true)
    process.env[PRIVACY_FLAG_VAR] = 'true'
    expect(isPrivacyEnabled('testnet')).toBe(true)
  })

  it('cannot be turned on while the network is mainnet', () => {
    process.env[PRIVACY_FLAG_VAR] = 'true'
    expect(isPrivacyEnabled('mainnet')).toBe(false)
  })

  it('defaults to the active network', () => {
    expect(isPrivacyEnabled()).toBe(isPrivacyEnabled(getNetworkName()))
  })
})

describe('per-network SPP config', () => {
  it('has no entry for mainnet', () => {
    expect(SPP_NETWORKS.mainnet).toBeUndefined()
    expect(getSppConfig('mainnet')).toBeNull()
  })

  it('matches the pinned deployments.json contract IDs on testnet', () => {
    expect(getSppConfig('testnet')).toMatchObject({
      aspMembership: 'CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGC',
      aspNonMembership: 'CAFLZKGO3KYKNOBPCVT3APFEWMUBRDBF4EVYK65E6O653WYMX4XH4QYJ',
      publicKeyRegistry: 'CC6EJCBEULJGHNQQROKLXD6M6IKFW6LN7IHTVUEFQQWZDDLCMNPWXIH4',
      bootnodeUrl: 'https://bootnode.dev-nethermind.xyz',
    })
  })

  it('matches the pinned deployments.json verifiers on testnet', () => {
    expect(getSppConfig('testnet')?.verifiers).toEqual({
      standard: 'CD34JHLNB7AYASRLOTMT6EECBKFMOS356PPP5RPXRO5Y5EA5Y4DIXGTV',
      traceable: 'CDBA2ZZSVV5VVE4OL2ORCSG2XDN4CD2UPTZIEO7BI32RKRTPFCUF2FMV',
    })
  })

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
    ])
  })
})

describe('association-set policy (V132)', () => {
  it('defaults to blocklist policy', () => {
    expect(DEFAULT_ASSOCIATION_SET_POLICY).toBe('blocklist')
    expect(getAssociationSetPolicy()).toBe('blocklist')
  })

  it('allows changing policy via configuration without code changes', () => {
    process.env[ASP_POLICY_VAR] = 'allowlist'
    expect(getAssociationSetPolicy()).toBe('allowlist')

    process.env[ASP_POLICY_VAR] = 'blocklist'
    expect(getAssociationSetPolicy()).toBe('blocklist')

    // Invalid env string falls back to default
    process.env[ASP_POLICY_VAR] = 'invalid-policy'
    expect(getAssociationSetPolicy()).toBe('blocklist')
  })

  it('selects the correct ASP contract based on policy and network', () => {
    const testnetConfig = getSppConfig('testnet')!
    expect(getAssociationSetContract('testnet', 'blocklist')).toBe(testnetConfig.aspNonMembership)
    expect(getAssociationSetContract('testnet', 'allowlist')).toBe(testnetConfig.aspMembership)

    // Falls back to active configured policy
    expect(getAssociationSetContract('testnet')).toBe(testnetConfig.aspNonMembership)

    // Mainnet has no deployment, returns null
    expect(getAssociationSetContract('mainnet', 'blocklist')).toBeNull()
  })

  it('provides honest and accurate anonymity set descriptions', () => {
    const blocklistMeta = getPolicyMetadata('blocklist')
    expect(blocklistMeta.anonymitySetDescription).toContain('all non-excluded depositors in this pool')
    expect(blocklistMeta.anonymitySetDescription).not.toContain('everyone on Stellar')
    expect(blocklistMeta.exclusionExplanation).toContain('cannot construct valid non-membership proofs')

    const allowlistMeta = getPolicyMetadata('allowlist')
    expect(allowlistMeta.anonymitySetDescription).toContain('pre-approved members')
  })

  it('differentiates policy rejection errors from generic proving failures', () => {
    expect(isPolicyRejectionError('POLICY_REJECTED: note is on ASP blocklist')).toBe(true)
    expect(isPolicyRejectionError('ASP rejection: non-membership proof rejected')).toBe(true)
    expect(isPolicyRejectionError(new Error('Blocked deposit cannot be spent'))).toBe(true)
    expect(isPolicyRejectionError('wasm out of memory')).toBe(false)
    expect(isPolicyRejectionError(new Error('Curve point not on curve'))).toBe(false)
    expect(isPolicyRejectionError(null)).toBe(false)
  })

  it('formats privacy errors with distinct user-facing messages', () => {
    const policyErr = formatPrivacyError(new Error('ASP rejection: non-membership proof rejected'))
    expect(policyErr.code).toBe('POLICY_REJECTED')
    expect(policyErr.isPolicyRejection).toBe(true)
    expect(policyErr.userFacingMessage).toContain('Transaction rejected by compliance policy')

    const genericErr = formatPrivacyError(new Error('Constraint system unsatisfiable'))
    expect(genericErr.code).toBe('PROVING_FAILED')
    expect(genericErr.isPolicyRejection).toBe(false)
    expect(genericErr.userFacingMessage).toContain('Failed to generate or verify zero-knowledge proof')
  })
})