/**
 * @jest-environment node
 *
 * Live SPP drift check (#796): compares the pinned config against the real upstream
 * deployments.json over the network.
 *
 * Skipped unless `SPP_DRIFT_LIVE=1`, so `npm test` (and every contributor's PR) never depends on a
 * third party being up. The scheduled workflow sets it. This runs the same `checkSppDrift` that
 * `drift.test.ts` covers, so there is one implementation of the comparison, not two.
 *
 * Environment:
 *   SPP_DRIFT_LIVE=1          run the check
 *   SPP_DRIFT_WARN_ONLY=1     report drift / unreachable upstream but do not fail
 *   SPP_DRIFT_REPORT=<path>   on drift, also write the report here (the workflow files an issue from it)
 */

import { writeFileSync } from 'fs'

import { SPP_UPSTREAM_DEPLOYMENTS_URL, checkSppDrift } from '../drift'

const live = process.env.SPP_DRIFT_LIVE === '1'
const warnOnly = process.env.SPP_DRIFT_WARN_ONLY === '1'

;(live ? it : it.skip)('pinned SPP testnet config matches upstream deployments.json', async () => {
  const result = await checkSppDrift()

  if (result.status === 'drift-detected') {
    const report = `${result.diffSummary}\n\nUpstream source: ${SPP_UPSTREAM_DEPLOYMENTS_URL}\n`
    const reportPath = process.env.SPP_DRIFT_REPORT
    if (reportPath) writeFileSync(reportPath, report, 'utf8')

    if (warnOnly) {
      console.warn(report)
      return
    }
    throw new Error(report)
  }

  if (result.status === 'upstream-unreachable') {
    // Not drift: no report file is written, so the workflow does not open an issue for it.
    const message = `Upstream SPP deployments unreachable: ${result.error}`
    if (warnOnly) {
      console.warn(message)
      return
    }
    throw new Error(message)
  }

  expect(result.status).toBe('in-sync')
})
