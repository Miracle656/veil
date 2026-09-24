import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { getSppConfig } from '../config'
import {
  diffSppDeployments,
  fetchUpstreamDeployments,
  formatDriftReport,
  type SppUpstreamDeployments,
} from '../drift'

// Real testnet deployment fixture matching pinned config
const IN_SYNC_DEPLOYMENT_FIXTURE: SppUpstreamDeployments = {
  network: 'testnet',
  deployer: 'GDX6X7DZQGIAGP6MWUK24BRQFDNQCP6E4FCJ4M6K3OCTNQM3EMWLQGPH',
  admin: 'GCBU2YCJGVLRSPPFK3ADYNUEH2W6ZFNNJLX6IHCEZT54VOHZZNYNHXDG',
  asp_membership: 'CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGC',
  asp_non_membership: 'CAFLZKGO3KYKNOBPCVT3APFEWMUBRDBF4EVYK65E6O653WYMX4XH4QYJ',
  verifiers: {
    B: 'CD34JHLNB7AYASRLOTMT6EECBKFMOS356PPP5RPXRO5Y5EA5Y4DIXGTV',
    B_gvk_T: 'CDBA2ZZSVV5VVE4OL2ORCSG2XDN4CD2UPTZIEO7BI32RKRTPFCUF2FMV',
  },
  public_key_registry: 'CC6EJCBEULJGHNQQROKLXD6M6IKFW6LN7IHTVUEFQQWZDDLCMNPWXIH4',
  pools: [
    {
      poolContractId: 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT',
      tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      deploymentLedger: 4831618,
      enabled: true,
      policyFlags: ['blocklist'],
      asset: { kind: 'native' },
    },
    {
      poolContractId: 'CADS665GRBHOMPE7GY5XYTFT2J5JKRZN6ILYMJ5ZO62GU4YPL3PYIN42',
      tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      deploymentLedger: 4831623,
      enabled: true,
      policyFlags: ['blocklist'],
      asset: { kind: 'native' },
      gvkMode: 'traceable',
    },
  ],
}

describe('SPP Deployment Drift Detection (Issue #796)', () => {
  const pinnedConfig = getSppConfig('testnet')!

  it('reports in_sync when pinned config matches upstream deployments exactly', () => {
    const result = diffSppDeployments(pinnedConfig, IN_SYNC_DEPLOYMENT_FIXTURE)
    expect(result.status).toBe('in_sync')
    expect(result.diffs).toHaveLength(0)
    expect(formatDriftReport(result.diffs)).toContain('in sync with upstream')
  })

  it('acceptance criterion: proves detection using a fixture that differs by one id (pool ID changed)', () => {
    const driftFixture: SppUpstreamDeployments = {
      ...IN_SYNC_DEPLOYMENT_FIXTURE,
      pools: [
        {
          ...IN_SYNC_DEPLOYMENT_FIXTURE.pools![0],
          poolContractId: 'CNEWREDEPLOYEDPOOLCONTRACTID1234567890123456789012345678901',
        },
        IN_SYNC_DEPLOYMENT_FIXTURE.pools![1],
      ],
    }

    const result = diffSppDeployments(pinnedConfig, driftFixture)
    expect(result.status).toBe('drift')
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0]).toEqual({
      field: 'pools[0].id',
      pinned: 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT',
      upstream: 'CNEWREDEPLOYEDPOOLCONTRACTID1234567890123456789012345678901',
    })

    const report = formatDriftReport(result.diffs)
    expect(report).toContain('CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT')
    expect(report).toContain('CNEWREDEPLOYEDPOOLCONTRACTID1234567890123456789012345678901')
  })

  it('acceptance criterion: reports changed ASP membership with old and new values', () => {
    const driftFixture: SppUpstreamDeployments = {
      ...IN_SYNC_DEPLOYMENT_FIXTURE,
      asp_membership: 'CNEWASPMEMBERSHIPCONTRACTID12345678901234567890123456789012',
    }

    const result = diffSppDeployments(pinnedConfig, driftFixture)
    expect(result.status).toBe('drift')
    expect(result.diffs).toContainEqual({
      field: 'aspMembership',
      pinned: 'CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGC',
      upstream: 'CNEWASPMEMBERSHIPCONTRACTID12345678901234567890123456789012',
    })
  })

  it('acceptance criterion: reports changed verifier ID with old and new values', () => {
    const driftFixture: SppUpstreamDeployments = {
      ...IN_SYNC_DEPLOYMENT_FIXTURE,
      verifiers: {
        ...IN_SYNC_DEPLOYMENT_FIXTURE.verifiers,
        B: 'CNEWSTANDARDVERIFIERCONTRACTID12345678901234567890123456789',
      },
    }

    const result = diffSppDeployments(pinnedConfig, driftFixture)
    expect(result.status).toBe('drift')
    expect(result.diffs).toContainEqual({
      field: 'verifiers.standard',
      pinned: 'CD34JHLNB7AYASRLOTMT6EECBKFMOS356PPP5RPXRO5Y5EA5Y4DIXGTV',
      upstream: 'CNEWSTANDARDVERIFIERCONTRACTID12345678901234567890123456789',
    })
  })

  it('acceptance criterion: reports changed public_key_registry ID with old and new values', () => {
    const driftFixture: SppUpstreamDeployments = {
      ...IN_SYNC_DEPLOYMENT_FIXTURE,
      public_key_registry: 'CNEWPUBLICKEYREGISTRYCONTRACTID1234567890123456789012345678',
    }

    const result = diffSppDeployments(pinnedConfig, driftFixture)
    expect(result.status).toBe('drift')
    expect(result.diffs).toContainEqual({
      field: 'publicKeyRegistry',
      pinned: 'CC6EJCBEULJGHNQQROKLXD6M6IKFW6LN7IHTVUEFQQWZDDLCMNPWXIH4',
      upstream: 'CNEWPUBLICKEYREGISTRYCONTRACTID1234567890123456789012345678',
    })
  })

  it('acceptance criterion: an unreachable upstream is distinguishable from a real drift', async () => {
    // Network failure / unreachable upstream mock
    const mockUnreachableFetch = jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'))

    const fetchResult = await fetchUpstreamDeployments(mockUnreachableFetch as any)
    expect(fetchResult.status).toBe('unreachable')
    if (fetchResult.status === 'unreachable') {
      expect(fetchResult.error).toContain('ENOTFOUND')
    }

    // HTTP 503 error
    const mock503Fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    })
    const httpErrorResult = await fetchUpstreamDeployments(mock503Fetch as any)
    expect(httpErrorResult.status).toBe('unreachable')
    if (httpErrorResult.status === 'unreachable') {
      expect(httpErrorResult.error).toContain('503')
    }
  })
})
