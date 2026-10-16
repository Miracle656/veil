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

// Below the polyfills on purpose: Babel keeps these requires in source order,
// and the SDK reads crypto/TextEncoder while it is being imported.
import { StrKey } from '@stellar/stellar-sdk'
import { getNetworkName } from '../../network'
import {
  SPP_NETWORKS,
  getSppConfig,
  getSppBootnodeUrl,
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

  /**
   * These assert the SHAPE of the pinned config, never its values.
   *
   * SPP redeploys testnet often — three times since August, most recently for a
   * change to the sparse Merkle tree depth — and every address changes when it
   * does. A test that re-types the addresses only ever says "config.ts contains
   * what config.ts contains", and it turns each redeploy into a three-file edit
   * where one of the three is busywork.
   *
   * The values are verified where they can actually be wrong: `drift.live.test.ts`
   * compares them against Nethermind's own deployments.json. What is worth
   * checking here is what that cannot catch — a malformed address, a duplicated
   * pool, a pool missing its policy.
   */
  it('pins well-formed contract and account IDs on testnet', () => {
    const config = getSppConfig('testnet')
    expect(config).not.toBeNull()

    for (const [field, value] of [
      ['aspMembership', config!.aspMembership],
      ['aspNonMembership', config!.aspNonMembership],
      ['publicKeyRegistry', config!.publicKeyRegistry],
      ['verifiers.standard', config!.verifiers.standard],
      ['verifiers.traceable', config!.verifiers.traceable],
    ] as const) {
      expect(`${field}:${StrKey.isValidContract(value)}`).toBe(`${field}:true`)
    }

    for (const [field, value] of [
      ['deployer', config!.deployer],
      ['admin', config!.admin],
    ] as const) {
      expect(`${field}:${StrKey.isValidEd25519PublicKey(value)}`).toBe(`${field}:true`)
    }

    expect(config!.bootnodeUrl).toMatch(/^https:\/\//)
  })

  it('uses Veil’s configured archive URL when supplied', () => {
    expect(getSppBootnodeUrl('https://bootnode.veil.app/ ')).toBe('https://bootnode.veil.app/')
    expect(getSppBootnodeUrl('')).toBe('https://bootnode.dev-nethermind.xyz')
  })

  it('keeps the two verifiers distinct', () => {
    // One proves a standard withdrawal, the other a traceable one. The same id
    // in both would mean one of them was pasted over the other, and the pool
    // whose anonymity guarantee differs would quietly stop differing.
    const verifiers = getSppConfig('testnet')!.verifiers
    expect(verifiers.standard).not.toBe(verifiers.traceable)
  })

  it('pins usable pools, each distinct', () => {
    const pools = getSppConfig('testnet')!.pools
    expect(pools.length).toBeGreaterThan(0)

    for (const pool of pools) {
      expect(`${pool.id}:${StrKey.isValidContract(pool.id)}`).toBe(`${pool.id}:true`)
      expect(StrKey.isValidContract(pool.tokenContractId)).toBe(true)
      expect(pool.policyFlags.length).toBeGreaterThan(0)
      expect(pool.deploymentLedger).toBeGreaterThan(0)
      expect(pool.assetKind).toBe('native')
    }

    // A duplicated id would silently halve the pools on offer.
    expect(new Set(pools.map((pool) => pool.id)).size).toBe(pools.length)
  })

  it('marks exactly one pool traceable', () => {
    // Traceable means a global view key can see into it. If every pool carried
    // one, "private" would mean nothing; if none did, the traceable flow would
    // have no pool to use.
    const traceable = getSppConfig('testnet')!.pools.filter((pool) => pool.gvkMode === 'traceable')
    expect(traceable).toHaveLength(1)
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
