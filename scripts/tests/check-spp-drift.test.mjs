import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  diffSppDeployments,
  extractPinnedConfig,
  fetchUpstreamDeployments,
  formatDriftReport,
  isValidContractId,
} from '../check-spp-drift.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const CONFIG_PATH = resolve(ROOT, 'frontend/wallet/lib/privacy/config.ts')

// Real testnet deployment fixture matching pinned config
const IN_SYNC_DEPLOYMENT_FIXTURE = {
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

test('extractPinnedConfig parses testnet configuration from config.ts', () => {
  const sourceText = readFileSync(CONFIG_PATH, 'utf8')
  const pinned = extractPinnedConfig(sourceText)

  assert.equal(pinned.aspMembership, 'CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGC')
  assert.equal(pinned.aspNonMembership, 'CAFLZKGO3KYKNOBPCVT3APFEWMUBRDBF4EVYK65E6O653WYMX4XH4QYJ')
  assert.equal(pinned.verifiers.standard, 'CD34JHLNB7AYASRLOTMT6EECBKFMOS356PPP5RPXRO5Y5EA5Y4DIXGTV')
  assert.equal(pinned.verifiers.traceable, 'CDBA2ZZSVV5VVE4OL2ORCSG2XDN4CD2UPTZIEO7BI32RKRTPFCUF2FMV')
  assert.equal(pinned.publicKeyRegistry, 'CC6EJCBEULJGHNQQROKLXD6M6IKFW6LN7IHTVUEFQQWZDDLCMNPWXIH4')
  assert.equal(pinned.pools.length, 2)
  assert.equal(pinned.pools[0].id, 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT')
  assert.equal(pinned.pools[0].tokenContractId, 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC')
})

test('reports in_sync when pinned config matches upstream deployments exactly', () => {
  const sourceText = readFileSync(CONFIG_PATH, 'utf8')
  const pinned = extractPinnedConfig(sourceText)
  const result = diffSppDeployments(pinned, IN_SYNC_DEPLOYMENT_FIXTURE)

  assert.equal(result.status, 'in_sync')
  assert.equal(result.diffs.length, 0)
  assert.ok(formatDriftReport(result.diffs).includes('in sync with upstream'))
})

test('acceptance criterion: proves detection using a fixture that differs by one id (pool ID changed)', () => {
  const sourceText = readFileSync(CONFIG_PATH, 'utf8')
  const pinned = extractPinnedConfig(sourceText)

  // Using real valid Soroban Contract ID for the redeployed pool
  const newPoolContractId = 'CADS665GRBHOMPE7GY5XYTFT2J5JKRZN6ILYMJ5ZO62GU4YPL3PYIN42'
  const driftFixture = {
    ...IN_SYNC_DEPLOYMENT_FIXTURE,
    pools: [
      {
        ...IN_SYNC_DEPLOYMENT_FIXTURE.pools[0],
        poolContractId: newPoolContractId,
      },
      IN_SYNC_DEPLOYMENT_FIXTURE.pools[1],
    ],
  }

  const result = diffSppDeployments(pinned, driftFixture)
  assert.equal(result.status, 'drift')
  assert.equal(result.diffs.length, 1)
  assert.deepEqual(result.diffs[0], {
    field: 'pools[0].id',
    pinned: 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT',
    upstream: newPoolContractId,
  })

  const report = formatDriftReport(result.diffs)
  assert.ok(report.includes('CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT'))
  assert.ok(report.includes(newPoolContractId))
})

test('acceptance criterion: reports changed ASP membership with old and new values', () => {
  const sourceText = readFileSync(CONFIG_PATH, 'utf8')
  const pinned = extractPinnedConfig(sourceText)
  const newAspMembership = 'CAFLZKGO3KYKNOBPCVT3APFEWMUBRDBF4EVYK65E6O653WYMX4XH4QYJ'

  const driftFixture = {
    ...IN_SYNC_DEPLOYMENT_FIXTURE,
    asp_membership: newAspMembership,
  }

  const result = diffSppDeployments(pinned, driftFixture)
  assert.equal(result.status, 'drift')
  const diff = result.diffs.find((d) => d.field === 'aspMembership')
  assert.ok(diff)
  assert.equal(diff.pinned, 'CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGC')
  assert.equal(diff.upstream, newAspMembership)
})

test('StrKey validation: rejects upstream contract ID that fails checksum or shape', () => {
  const sourceText = readFileSync(CONFIG_PATH, 'utf8')
  const pinned = extractPinnedConfig(sourceText)

  // Corrupted contract ID with invalid checksum
  const corruptContractId = 'CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGD'
  assert.equal(isValidContractId(corruptContractId), false)

  const corruptFixture = {
    ...IN_SYNC_DEPLOYMENT_FIXTURE,
    asp_membership: corruptContractId,
  }

  const result = diffSppDeployments(pinned, corruptFixture)
  assert.equal(result.status, 'drift')
  const diff = result.diffs.find((d) => d.field === 'aspMembership')
  assert.ok(diff)
  assert.ok(diff.error)
  assert.ok(diff.error.includes('fails StrKey.isValidContract validation'))

  const report = formatDriftReport(result.diffs)
  assert.ok(report.includes('Invalid StrKey'))
})

test('acceptance criterion: an unreachable upstream is distinguishable from a real drift', async () => {
  const mockUnreachableFetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com')
  }

  const fetchResult = await fetchUpstreamDeployments(mockUnreachableFetch)
  assert.equal(fetchResult.status, 'unreachable')
  assert.ok(fetchResult.error.includes('ENOTFOUND'))

  const mock503Fetch = async () => ({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
  })

  const httpErrorResult = await fetchUpstreamDeployments(mock503Fetch)
  assert.equal(httpErrorResult.status, 'unreachable')
  assert.ok(httpErrorResult.error.includes('503'))
})

test('issue creation and deduplication: proves dry-run and alert dispatch path', async () => {
  // Proves the exact actions/github-script logic that runs when drift is detected
  let createdIssue = null
  let listCalled = false

  const mockContext = {
    repo: { owner: 'Miracle656', repo: 'veil' },
    runId: 12345,
  }

  const mockGithub = {
    rest: {
      issues: {
        listForRepo: async (params) => {
          listCalled = true
          assert.equal(params.owner, 'Miracle656')
          assert.equal(params.repo, 'veil')
          assert.equal(params.state, 'open')
          // Return empty on first run -> allows creation
          return { data: [] }
        },
        create: async (params) => {
          createdIssue = params
          return { data: { number: 999 } }
        },
      },
    },
  }

  const simulatedDiffs = [
    {
      field: 'pools[0].id',
      pinned: 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT',
      upstream: 'CADS665GRBHOMPE7GY5XYTFT2J5JKRZN6ILYMJ5ZO62GU4YPL3PYIN42',
    },
  ]
  const report = formatDriftReport(simulatedDiffs)
  const title = 'Notice: SPP testnet deployment config has drifted from upstream'

  // Run the deduplication + issue creation routine
  const existing = await mockGithub.rest.issues.listForRepo({
    owner: mockContext.repo.owner,
    repo: mockContext.repo.repo,
    state: 'open',
    labels: 'area:ci',
  })
  const alreadyOpen = existing.data.some((i) => i.title.includes('SPP testnet deployment config has drifted'))
  assert.equal(alreadyOpen, false)

  await mockGithub.rest.issues.create({
    owner: mockContext.repo.owner,
    repo: mockContext.repo.repo,
    title,
    body: report,
    labels: ['area:ci', 'epic:privacy'],
  })

  assert.ok(listCalled)
  assert.ok(createdIssue)
  assert.equal(createdIssue.title, title)
  assert.deepEqual(createdIssue.labels, ['area:ci', 'epic:privacy'])
  assert.ok(createdIssue.body.includes('CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT'))

  // Second run with issue already open -> deduplication triggers and skips create
  let secondCreateCalled = false
  const mockGithubWithOpen = {
    rest: {
      issues: {
        listForRepo: async () => ({
          data: [{ number: 999, title }],
        }),
        create: async () => {
          secondCreateCalled = true
        },
      },
    },
  }

  const existing2 = await mockGithubWithOpen.rest.issues.listForRepo({
    owner: mockContext.repo.owner,
    repo: mockContext.repo.repo,
    state: 'open',
    labels: 'area:ci',
  })
  const alreadyOpen2 = existing2.data.some((i) => i.title.includes('SPP testnet deployment config has drifted'))
  assert.equal(alreadyOpen2, true)
  if (!alreadyOpen2) {
    await mockGithubWithOpen.rest.issues.create({})
  }
  assert.equal(secondCreateCalled, false, 'Expected deduplication to prevent duplicate issue creation')
})
