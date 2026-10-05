/**
 * @jest-environment jsdom
 *
 * Tests for Stellar Private Payments (SPP) upstream drift detector (lib/privacy/drift.ts).
 *
 * The "upstream" JSON used here is derived from the pinned config itself, in the shape of the real
 * deployments/testnet/deployments.json, instead of copying contract ids into this file. That keeps
 * the fixture in step with `config.ts` and keeps contract-id literals out of the test.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { SPP_NETWORKS, type SppNetworkConfig } from '../config'
import {
  compareSppDeployments,
  formatDriftDiff,
  checkSppDrift,
  type UpstreamDeploymentsJson,
  type UpstreamPool,
} from '../drift'

// Obviously-fake, low-entropy stand-ins for "a different contract".
const OTHER_ID = 'C' + 'A'.repeat(55)
const ANOTHER_ID = 'C' + 'B'.repeat(55)

/** An upstream deployments.json that matches `pinned` exactly (no bootnode: upstream publishes none). */
function upstreamFrom(pinned: SppNetworkConfig): UpstreamDeploymentsJson {
  return {
    network: 'testnet',
    deployer: pinned.deployer,
    admin: pinned.admin,
    asp_membership: pinned.aspMembership,
    asp_non_membership: pinned.aspNonMembership,
    verifiers: { B: pinned.verifiers.standard, B_gvk_T: pinned.verifiers.traceable },
    public_key_registry: pinned.publicKeyRegistry,
    pools: pinned.pools.map((p) => ({
      poolContractId: p.id,
      tokenContractId: p.tokenContractId,
      deploymentLedger: p.deploymentLedger,
      enabled: true,
      policyFlags: [...p.policyFlags],
      asset: { kind: p.assetKind },
      ...(p.gvkMode ? { gvkMode: p.gvkMode } : {}),
    })),
  }
}

/** A deep copy of the matching upstream, for a test to mutate. */
function freshUpstream(pinned: SppNetworkConfig): UpstreamDeploymentsJson & { pools: UpstreamPool[] } {
  return JSON.parse(JSON.stringify(upstreamFrom(pinned)))
}

const keysOf = (drifts: { key: string }[]) => drifts.map((d) => d.key).sort()

describe('compareSppDeployments', () => {
  const pinned = SPP_NETWORKS.testnet!

  it('reports nothing when upstream matches the pinned config exactly', () => {
    expect(compareSppDeployments(pinned, upstreamFrom(pinned))).toEqual([])
  })

  it('ignores extra upstream fields it does not pin (e.g. gvkAuthorityPubKey, enabled)', () => {
    const upstream = freshUpstream(pinned)
    upstream.pools[1]!.gvkAuthorityPubKey = { x: '0x1', y: '0x2' }
    upstream.somethingNew = { whatever: true }
    expect(compareSppDeployments(pinned, upstream)).toEqual([])
  })

  describe('contract and account ids', () => {
    const cases: Array<[string, (u: UpstreamDeploymentsJson) => void]> = [
      ['deployer', (u) => (u.deployer = OTHER_ID)],
      ['admin', (u) => (u.admin = OTHER_ID)],
      ['aspMembership', (u) => (u.asp_membership = OTHER_ID)],
      ['aspNonMembership', (u) => (u.asp_non_membership = OTHER_ID)],
      ['verifiers.standard', (u) => (u.verifiers!.B = OTHER_ID)],
      ['verifiers.traceable', (u) => (u.verifiers!.B_gvk_T = OTHER_ID)],
      ['publicKeyRegistry', (u) => (u.public_key_registry = OTHER_ID)],
    ]

    it.each(cases)('detects a changed %s', (key, mutate) => {
      const upstream = freshUpstream(pinned)
      mutate(upstream)
      const drifts = compareSppDeployments(pinned, upstream)
      expect(drifts).toHaveLength(1)
      expect(drifts[0]).toMatchObject({ key, upstreamValue: OTHER_ID })
      expect(drifts[0]!.pinnedValue).not.toBe(OTHER_ID)
    })

    it('accepts the camelCase aliases for the same fields', () => {
      const upstream: UpstreamDeploymentsJson = {
        ...upstreamFrom(pinned),
        aspMembership: pinned.aspMembership,
        asp_membership: undefined,
        publicKeyRegistry: pinned.publicKeyRegistry,
        public_key_registry: undefined,
      }
      expect(compareSppDeployments(pinned, upstream)).toEqual([])
    })

    it('treats a field upstream no longer publishes as drift, not as a pass', () => {
      const upstream = freshUpstream(pinned)
      delete upstream.asp_non_membership
      delete upstream.deployer
      const drifts = compareSppDeployments(pinned, upstream)
      expect(keysOf(drifts)).toEqual(['aspNonMembership', 'deployer'])
      expect(drifts.every((d) => d.upstreamValue === '<missing in upstream>')).toBe(true)
    })

    it('reports a missing pools array', () => {
      const upstream = freshUpstream(pinned) as UpstreamDeploymentsJson
      delete upstream.pools
      expect(keysOf(compareSppDeployments(pinned, upstream))).toEqual(['pools'])
    })
  })

  describe('bootnode', () => {
    it('is not compared when upstream does not publish one (it does not today)', () => {
      expect(compareSppDeployments(pinned, upstreamFrom(pinned))).toEqual([])
    })

    it('is compared once upstream publishes it', () => {
      const upstream = { ...freshUpstream(pinned), bootnode_url: 'https://bootnode.example.invalid' }
      const drifts = compareSppDeployments(pinned, upstream)
      expect(drifts).toEqual([
        {
          key: 'bootnodeUrl',
          pinnedValue: pinned.bootnodeUrl,
          upstreamValue: 'https://bootnode.example.invalid',
        },
      ])
    })

    it('passes when a published bootnode matches', () => {
      const upstream = { ...freshUpstream(pinned), bootnode_url: pinned.bootnodeUrl }
      expect(compareSppDeployments(pinned, upstream)).toEqual([])
    })
  })

  describe('pools are matched by contract id, not by position', () => {
    it('does not report drift when upstream reorders its pools', () => {
      const upstream = freshUpstream(pinned)
      upstream.pools.reverse()
      expect(compareSppDeployments(pinned, upstream)).toEqual([])
    })

    it('reports only the new pool when upstream inserts one at position 0', () => {
      const upstream = freshUpstream(pinned)
      upstream.pools.unshift({
        poolContractId: OTHER_ID,
        tokenContractId: ANOTHER_ID,
        enabled: true,
        policyFlags: ['allowlist'],
        asset: { kind: 'soroban' },
      })
      const drifts = compareSppDeployments(pinned, upstream)
      // the existing pools are NOT compared against the wrong entry
      expect(drifts).toEqual([
        { key: 'pools.unpinnedUpstream', pinnedValue: '<not pinned>', upstreamValue: OTHER_ID },
      ])
    })

    it('reports a pinned pool that upstream has dropped, separately from unpinned upstream pools', () => {
      const upstream = freshUpstream(pinned)
      const dropped = upstream.pools.shift()!
      upstream.pools.push({
        poolContractId: OTHER_ID,
        tokenContractId: pinned.pools[0]!.tokenContractId,
        enabled: true,
        policyFlags: ['blocklist'],
        asset: { kind: 'native' },
      })
      const drifts = compareSppDeployments(pinned, upstream)
      expect(drifts).toEqual(
        expect.arrayContaining([
          {
            key: 'pools.pinnedMissingUpstream',
            pinnedValue: dropped.poolContractId,
            upstreamValue: '<not present upstream>',
          },
          { key: 'pools.unpinnedUpstream', pinnedValue: '<not pinned>', upstreamValue: OTHER_ID },
        ]),
      )
      expect(drifts).toHaveLength(2)
    })

    it('ignores an upstream pool that is disabled and not pinned', () => {
      const upstream = freshUpstream(pinned)
      upstream.pools.push({
        poolContractId: OTHER_ID,
        tokenContractId: ANOTHER_ID,
        enabled: false,
        policyFlags: ['blocklist'],
        asset: { kind: 'native' },
      })
      expect(compareSppDeployments(pinned, upstream)).toEqual([])
    })
  })

  describe('quiet drift: same contract ids, different meaning', () => {
    const firstPool = () => pinned.pools[0]!

    it('detects a pool token change', () => {
      const upstream = freshUpstream(pinned)
      upstream.pools[0]!.tokenContractId = OTHER_ID
      expect(compareSppDeployments(pinned, upstream)).toEqual([
        {
          key: `pools[${firstPool().id}].tokenContractId`,
          pinnedValue: firstPool().tokenContractId,
          upstreamValue: OTHER_ID,
        },
      ])
    })

    it('detects blocklist flipping to allowlist', () => {
      const upstream = freshUpstream(pinned)
      upstream.pools[0]!.policyFlags = ['allowlist']
      expect(compareSppDeployments(pinned, upstream)).toEqual([
        {
          key: `pools[${firstPool().id}].policyFlags`,
          pinnedValue: 'blocklist',
          upstreamValue: 'allowlist',
        },
      ])
    })

    it('does not treat a reordered policy-flag list as drift', () => {
      const upstream = freshUpstream(pinned)
      upstream.pools[0]!.policyFlags = [...pinned.pools[0]!.policyFlags].reverse()
      expect(compareSppDeployments(pinned, upstream)).toEqual([])
    })

    it('detects an asset kind change', () => {
      const upstream = freshUpstream(pinned)
      upstream.pools[0]!.asset = { kind: 'soroban' }
      expect(compareSppDeployments(pinned, upstream)).toEqual([
        {
          key: `pools[${firstPool().id}].assetKind`,
          pinnedValue: 'native',
          upstreamValue: 'soroban',
        },
      ])
    })

    it('detects a pool becoming traceable, and a traceable pool losing its view key', () => {
      const becomesTraceable = freshUpstream(pinned)
      becomesTraceable.pools[0]!.gvkMode = 'traceable'
      expect(compareSppDeployments(pinned, becomesTraceable)).toEqual([
        {
          key: `pools[${firstPool().id}].gvkMode`,
          pinnedValue: 'none',
          upstreamValue: 'traceable',
        },
      ])

      const losesIt = freshUpstream(pinned)
      const traceable = pinned.pools.find((p) => p.gvkMode === 'traceable')!
      delete losesIt.pools.find((p) => p.poolContractId === traceable.id)!.gvkMode
      expect(compareSppDeployments(pinned, losesIt)).toEqual([
        { key: `pools[${traceable.id}].gvkMode`, pinnedValue: 'traceable', upstreamValue: 'none' },
      ])
    })

    it('detects a pinned pool that upstream has switched off', () => {
      const upstream = freshUpstream(pinned)
      upstream.pools[0]!.enabled = false
      expect(compareSppDeployments(pinned, upstream)).toEqual([
        {
          key: `pools[${firstPool().id}].enabled`,
          pinnedValue: 'enabled',
          upstreamValue: 'disabled',
        },
      ])
    })

    it('reports a pool whose policy flags upstream no longer publishes', () => {
      const upstream = freshUpstream(pinned)
      delete upstream.pools[0]!.policyFlags
      expect(compareSppDeployments(pinned, upstream)).toEqual([
        {
          key: `pools[${firstPool().id}].policyFlags`,
          pinnedValue: 'blocklist',
          upstreamValue: '<missing in upstream>',
        },
      ])
    })
  })

  it('reports several independent drifts together, in any order', () => {
    const upstream = freshUpstream(pinned)
    upstream.verifiers!.B = OTHER_ID
    upstream.pools[0]!.policyFlags = ['allowlist']
    const drifts = compareSppDeployments(pinned, upstream)
    expect(keysOf(drifts)).toEqual(
      ['verifiers.standard', `pools[${pinned.pools[0]!.id}].policyFlags`].sort(),
    )
  })
})

describe('formatDriftDiff', () => {
  it('formats clean message when in-sync', () => {
    expect(formatDriftDiff([])).toContain('No SPP config drift detected')
  })

  it('formats detailed diff when drift is present', () => {
    const diff = formatDriftDiff([{ key: 'aspMembership', pinnedValue: 'OLD_ID', upstreamValue: 'NEW_ID' }])
    expect(diff).toContain('SPP Configuration Drift Detected')
    expect(diff).toContain('- aspMembership:')
    expect(diff).toContain('pinned:   OLD_ID')
    expect(diff).toContain('upstream: NEW_ID')
    expect(diff).toContain('frontend/wallet/lib/privacy/config.ts')
  })
})

describe('checkSppDrift', () => {
  const pinned = SPP_NETWORKS.testnet!
  const jsonResponse = (body: unknown) =>
    jest.fn().mockResolvedValue({ ok: true, json: async () => body } as Response) as unknown as typeof fetch

  it('returns in-sync when upstream matches', async () => {
    const result = await checkSppDrift(pinned, jsonResponse(upstreamFrom(pinned)))
    expect(result.status).toBe('in-sync')
  })

  it('returns drift-detected with a readable summary when upstream differs', async () => {
    const drifted = freshUpstream(pinned)
    drifted.asp_membership = OTHER_ID
    const result = await checkSppDrift(pinned, jsonResponse(drifted))
    expect(result.status).toBe('drift-detected')
    if (result.status === 'drift-detected') {
      expect(result.drifts).toHaveLength(1)
      expect(result.diffSummary).toContain(OTHER_ID)
    }
  })

  it('returns upstream-unreachable on HTTP error', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response)
    const result = await checkSppDrift(pinned, mockFetch as unknown as typeof fetch)
    expect(result.status).toBe('upstream-unreachable')
    if (result.status === 'upstream-unreachable') expect(result.statusCode).toBe(404)
  })

  it('returns upstream-unreachable on network exception', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('Connection timed out'))
    const result = await checkSppDrift(pinned, mockFetch as unknown as typeof fetch)
    expect(result.status).toBe('upstream-unreachable')
    if (result.status === 'upstream-unreachable') expect(result.error).toContain('Connection timed out')
  })

  it('returns upstream-unreachable when the body is not JSON', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    } as unknown as Response)
    const result = await checkSppDrift(pinned, mockFetch as unknown as typeof fetch)
    expect(result.status).toBe('upstream-unreachable')
  })

  it('reports a missing testnet pin as unreachable rather than comparing against nothing', async () => {
    const saved = SPP_NETWORKS.testnet
    try {
      delete SPP_NETWORKS.testnet
      const fetchFn = jest.fn()
      const result = await checkSppDrift(undefined, fetchFn as unknown as typeof fetch)
      expect(result.status).toBe('upstream-unreachable')
      if (result.status === 'upstream-unreachable') {
        expect(result.error).toContain('No pinned testnet SPP configuration')
      }
      expect(fetchFn).not.toHaveBeenCalled()
    } finally {
      SPP_NETWORKS.testnet = saved
    }
  })
})
