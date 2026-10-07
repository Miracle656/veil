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
 *   SPP_SDK_REPORT=<path>     same, for the stale-SDK finding
 */

import { writeFileSync } from 'fs'

import { SPP_UPSTREAM_DEPLOYMENTS_URL, checkSppDrift, checkSppSdkFreshness } from '../drift'

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

/**
 * Separate from the address check on purpose.
 *
 * The addresses being right says the app points at the live contracts. It does
 * not say a proof the app builds could be accepted by them — those are decided
 * by different things, and on 2026-10-05 the first was green while the second
 * had been wrong for a month. Running them as one test would let an npm outage
 * hide address drift, and would report "privacy is fine" on half the evidence.
 */
;(live ? it : it.skip)('published SPP SDK is no older than the deployed circuits', async () => {
  const result = await checkSppSdkFreshness()

  if (result.status === 'sdk-stale') {
    const report = `${result.summary}
`
    const reportPath = process.env.SPP_SDK_REPORT
    if (reportPath) writeFileSync(reportPath, report, 'utf8')

    if (warnOnly) {
      console.warn(report)
      return
    }
    throw new Error(report)
  }

  if (result.status === 'upstream-unreachable') {
    const message = `Could not check SPP SDK freshness: ${result.error}`
    if (warnOnly) {
      console.warn(message)
      return
    }
    throw new Error(message)
  }

  expect(result.status).toBe('in-sync')
})
