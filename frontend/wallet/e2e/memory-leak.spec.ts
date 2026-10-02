// @ts-ignore
import { test, expect, type Page } from '@playwright/test'
import { addVirtualAuthenticator } from './_authenticator'

// ── Constants ─────────────────────────────────────────────────────────────────

const SAMPLE_INTERVAL_MS = 60_000          // 1 minute between samples
const TOTAL_SAMPLES = 10                    // 10 post-baseline samples = 10-minute run
const HEAP_SLOPE_THRESHOLD = 5 * 1024 * 1024  // 5 MB/min max acceptable growth

// ── Helpers ───────────────────────────────────────────────────────────────────

async function stubNetworkCalls(page: Page) {
  // Horizon — polls every 30s in the PWA; return a static funded account
  await page.route('**/horizon-testnet.stellar.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'GTEST',
        account_id: 'GTEST',
        sequence: '0',
        subentry_count: 0,
        balances: [{ asset_type: 'native', balance: '10000.0000000' }],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: {},
        signers: [],
      }),
    }),
  )

  // Soroban RPC — acknowledge all calls with empty success
  await page.route('**/soroban-testnet.stellar.org', async (route) => {
    const postData = route.request().postDataJSON()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: postData?.id ?? 1, result: {} }),
    })
  })
}

function linearSlope(xs: number[], ys: number[]): number {
  const n = xs.length
  const meanX = xs.reduce((s, v) => s + v, 0) / n
  const meanY = ys.reduce((s, v) => s + v, 0) / n
  const num = xs.reduce((s, v, i) => s + (v - meanX) * (ys[i] - meanY), 0)
  const den = xs.reduce((s, v) => s + (v - meanX) ** 2, 0)
  return den === 0 ? 0 : num / den
}

// ── Test ──────────────────────────────────────────────────────────────────────

test.describe('Memory leak: long-running dashboard session @nightly', () => {
  test.setTimeout(15 * 60 * 1000)

  test('heap slope stays ≤ 5 MB/min over 10-minute polling run', async ({ page }) => {
    await addVirtualAuthenticator(page)
    await stubNetworkCalls(page)

    // Bypass onboarding — seed an existing wallet address
    await page.addInitScript(() => {
      localStorage.setItem('invisible_wallet_address', 'CFAKEWALLET123FAKE456')
    })

    await page.goto('/dashboard')
    await page.waitForLoadState('networkidle')

    const heapSamples: number[] = []
    const timeSamples: number[] = []

    // Baseline at t = 0
    const baseline: number = await page.evaluate(
      () => (performance as any).memory?.usedJSHeapSize ?? 0,
    )
    heapSamples.push(baseline)
    timeSamples.push(0)

    for (let i = 1; i <= TOTAL_SAMPLES; i++) {
      await page.waitForTimeout(SAMPLE_INTERVAL_MS)

      const heap: number = await page.evaluate(
        () => (performance as any).memory?.usedJSHeapSize ?? 0,
      )
      heapSamples.push(heap)
      timeSamples.push(i)
    }

    const allZero = heapSamples.every((v) => v === 0)
    test.skip(allZero, 'performance.memory not available in this browser — skipping heap assertion')

    const slope = linearSlope(timeSamples, heapSamples)
    const slopeMB = (slope / 1024 / 1024).toFixed(2)

    console.log(`Heap samples (bytes): ${heapSamples.join(', ')}`)
    console.log(`Heap growth slope: ${slopeMB} MB/min (threshold: ${HEAP_SLOPE_THRESHOLD / 1024 / 1024} MB/min)`)

    expect(
      slope,
      `Heap growing at ${slopeMB} MB/min — exceeds ${HEAP_SLOPE_THRESHOLD / 1024 / 1024} MB/min; listener leak likely`,
    ).toBeLessThanOrEqual(HEAP_SLOPE_THRESHOLD)
  })
})
