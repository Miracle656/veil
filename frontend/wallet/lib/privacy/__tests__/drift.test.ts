/**
 * @jest-environment jsdom
 *
 * Tests for Stellar Private Payments (SPP) upstream drift detector (lib/privacy/drift.ts).
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { SPP_NETWORKS } from '../config'
import {
  compareSppDeployments,
  formatDriftDiff,
  checkSppDrift,
  type UpstreamDeploymentsJson,
} from '../drift'

const mockValidUpstream: UpstreamDeploymentsJson = {
  asp_membership: 'CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGC',
  asp_non_membership: 'CAFLZKGO3KYKNOBPCVT3APFEWMUBRDBF4EVYK65E6O653WYMX4XH4QYJ',
  verifiers: {
    B: 'CD34JHLNB7AYASRLOTMT6EECBKFMOS356PPP5RPXRO5Y5EA5Y4DIXGTV',
    B_gvk_T: 'CDBA2ZZSVV5VVE4OL2ORCSG2XDN4CD2UPTZIEO7BI32RKRTPFCUF2FMV',
  },
  public_key_registry: 'CC6EJCBEULJGHNQQROKLXD6M6IKFW6LN7IHTVUEFQQWZDDLCMNPWXIH4',
  bootnode_url: 'https://bootnode.dev-nethermind.xyz',
  pools: [
    {
      poolContractId: 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT',
      tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    },
    {
      poolContractId: 'CADS665GRBHOMPE7GY5XYTFT2J5JKRZN6ILYMJ5ZO62GU4YPL3PYIN42',
      tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    },
  ],
}

describe('compareSppDeployments', () => {
  const pinned = SPP_NETWORKS.testnet!

  it('returns empty array when upstream matches pinned config exactly', () => {
    const drifts = compareSppDeployments(pinned, mockValidUpstream)
    expect(drifts).toHaveLength(0)
  })

  it('detects a 1-id drift in asp_membership', () => {
    const modifiedUpstream: UpstreamDeploymentsJson = {
      ...mockValidUpstream,
      asp_membership: 'CDRIFTEDMEMBERSHIPCONTRACTIDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }
    const drifts = compareSppDeployments(pinned, modifiedUpstream)
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toEqual({
      key: 'aspMembership',
      pinnedValue: pinned.aspMembership,
      upstreamValue: 'CDRIFTEDMEMBERSHIPCONTRACTIDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })
  })

  it('detects drift in verifiers and pools', () => {
    const modifiedUpstream: UpstreamDeploymentsJson = {
      ...mockValidUpstream,
      verifiers: {
        B: 'CDRIFTEDVERIFIERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        B_gvk_T: 'CDBA2ZZSVV5VVE4OL2ORCSG2XDN4CD2UPTZIEO7BI32RKRTPFCUF2FMV',
      },
      pools: [
        {
          poolContractId: 'CDRIFTEDPOOLIDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        },
        mockValidUpstream.pools![1],
      ],
    }
    const drifts = compareSppDeployments(pinned, modifiedUpstream)
    expect(drifts).toHaveLength(2)
    expect(drifts.map((d) => d.key)).toEqual(['verifiers.standard', 'pools[0].id'])
  })
})

describe('formatDriftDiff', () => {
  it('formats clean message when in-sync', () => {
    const msg = formatDriftDiff([])
    expect(msg).toContain('No SPP config drift detected')
  })

  it('formats detailed diff when drift is present', () => {
    const diff = formatDriftDiff([
      {
        key: 'aspMembership',
        pinnedValue: 'OLD_ID',
        upstreamValue: 'NEW_ID',
      },
    ])
    expect(diff).toContain('SPP Configuration Drift Detected')
    expect(diff).toContain('- aspMembership:')
    expect(diff).toContain('pinned:   OLD_ID')
    expect(diff).toContain('upstream: NEW_ID')
  })
})

describe('checkSppDrift', () => {
  const pinned = SPP_NETWORKS.testnet!

  it('returns in-sync when upstream matches', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => mockValidUpstream,
    } as Response)

    const result = await checkSppDrift(pinned, mockFetch as unknown as typeof fetch)
    expect(result.status).toBe('in-sync')
  })

  it('returns drift-detected when upstream differs', async () => {
    const driftedUpstream = {
      ...mockValidUpstream,
      asp_membership: 'CDRIFTED11111111111111111111111111111111111111111111111111',
    }
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => driftedUpstream,
    } as Response)

    const result = await checkSppDrift(pinned, mockFetch as unknown as typeof fetch)
    expect(result.status).toBe('drift-detected')
    if (result.status === 'drift-detected') {
      expect(result.drifts).toHaveLength(1)
      expect(result.diffSummary).toContain('CDRIFTED11111111111111111111111111111111111111111111111111')
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
    if (result.status === 'upstream-unreachable') {
      expect(result.statusCode).toBe(404)
    }
  })

  it('returns upstream-unreachable on network exception', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('Connection timed out'))

    const result = await checkSppDrift(pinned, mockFetch as unknown as typeof fetch)
    expect(result.status).toBe('upstream-unreachable')
    if (result.status === 'upstream-unreachable') {
      expect(result.error).toContain('Connection timed out')
    }
  })
})
