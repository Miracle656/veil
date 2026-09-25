import { test, expect } from '@playwright/test'
import { Keypair } from '@stellar/stellar-sdk'
import { ASSET_REGISTRY } from '../lib/assets'
import { ISSUER_TOML_TTL_MS, MAX_ISSUER_LOGO_BYTES } from '../lib/issuerToml'

test.use({ serviceWorkers: 'block' })

const issuer = ASSET_REGISTRY.USDC.issuer
const unknownIssuer = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
const logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="blue"/></svg>')
const cacheKey = `veil_issuer_toml:v2:USDC:${issuer}`

test.beforeEach(async ({ page }) => {
  await page.addInitScript((secret) => {
    localStorage.setItem('veil_network', 'mainnet')
    sessionStorage.setItem('veil_signer_secret_mainnet', secret)
  }, Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).secret())
  await page.route('https://horizon.stellar.org/**', (route) => route.fulfill({
    json: {
      account_id: route.request().url().split('/').pop(), sequence: '1',
      balances: [issuer, unknownIssuer].map((asset_issuer) => ({
        asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer, balance: '0', limit: '1000',
      })),
    },
  }))
  await page.route('https://ondo.finance/**', (route) => route.abort())
  // The logo route fetches on the server, out of Playwright's reach; stub it so
  // no test depends on the real issuer hosts.
  await page.route('**/api/issuer-logo?**', (route) => route.fulfill({ status: 502 }))
})

test('registered metadata, cached logo, offline fallback, and image recovery', async ({ page }) => {
  let tomlRequests = 0
  let imageRequests = 0
  let offline = false
  let broken = false
  await page.route('https://circle.com/.well-known/stellar.toml', (route) => {
    tomlRequests++
    return offline ? route.abort() : route.fulfill({
      contentType: 'text/plain', body: `[[CURRENCIES]]\ncode="USDC"\nissuer="${issuer}"\nname="Issuer supplied name"\ndesc="Issuer supplied description"\nimage="https://logos.example/usdc.svg"`,
    })
  })
  await page.route('https://logos.example/usdc.svg', (route) => {
    imageRequests++
    return route.fulfill({ contentType: 'image/svg+xml', body: broken ? Buffer.from('invalid image') : logo })
  })
  await page.goto('/assets')
  const verified = page.locator('.card').filter({ hasText: `Issuer: Circle` })
  await expect(verified).toContainText('Issuer supplied name')
  await expect(verified).toContainText('Issuer supplied description')
  await expect(verified.locator('img')).toHaveJSProperty('naturalWidth', 36)
  const unverified = page.locator('.card').filter({ hasText: unknownIssuer })
  await expect(unverified).not.toContainText('Issuer: Circle')
  await expect(unverified.locator('img')).toHaveCount(0)
  const initialRequests = [tomlRequests, imageRequests]
  await page.reload()
  await expect(verified.locator('img')).toHaveJSProperty('naturalWidth', 36)
  expect([tomlRequests, imageRequests]).toEqual(initialRequests)

  const expire = () => page.evaluate(({ key, ttl }) => {
    const entry = JSON.parse(localStorage.getItem(key)!)
    entry.fetchedAt = Date.now() - ttl - 1
    localStorage.setItem(key, JSON.stringify(entry))
  }, { key: cacheKey, ttl: ISSUER_TOML_TTL_MS })
  offline = true
  await expire()
  await page.reload()
  await expect.poll(() => tomlRequests).toBeGreaterThan(initialRequests[0])
  await expect(verified.locator('img')).toHaveJSProperty('naturalWidth', 36)

  offline = false
  broken = true
  await page.reload()
  await expect.poll(() => imageRequests).toBeGreaterThan(initialRequests[1])
  await expect(verified.locator('img')).toHaveCount(0)
  await expect(verified.locator('span[aria-hidden]')).toHaveText('U')
  broken = false
  await expire()
  await page.reload()
  await expect(verified.locator('img')).toHaveJSProperty('naturalWidth', 36)
})

for (const failure of ['oversized', 'http', 'unreadable', 'redirect', 'offline']) {
  test(`uses a letter for ${failure} metadata or logos`, async ({ page }) => {
    let imageRequests = 0
    let proxyRequests = 0
    await page.route('**/api/issuer-logo?**', (route) => { proxyRequests++; return route.fulfill({ status: 502 }) })
    await page.route('https://circle.com/.well-known/stellar.toml', (route) => failure === 'offline'
      ? route.abort()
      : route.fulfill({ contentType: 'text/plain', body: `[[CURRENCIES]]\ncode="USDC"\nissuer="${issuer}"\nimage="${failure === 'http' ? 'http' : 'https'}://logos.example/usdc.svg"` }))
    await page.route('**://logos.example/**', (route) => {
      // The insecure redirect target serves a valid logo; it must still be refused.
      if (route.request().url().endsWith('/insecure.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: logo })
      imageRequests++
      if (failure === 'unreadable') return route.abort()
      if (failure === 'redirect') return route.fulfill({ status: 302, headers: { location: 'http://logos.example/insecure.svg' } })
      return route.fulfill({ contentType: 'image/svg+xml', body: Buffer.alloc(MAX_ISSUER_LOGO_BYTES + 1) })
    })
    await page.goto('/assets')
    const verified = page.locator('.card').filter({ hasText: 'Issuer: Circle' })
    await expect(verified.locator('span[aria-hidden]')).toHaveText('U')
    if (failure !== 'offline') {
      await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), cacheKey)).not.toBeNull()
    }
    await expect(verified.locator('img')).toHaveCount(0)
    expect(imageRequests).toBe(failure === 'http' || failure === 'offline' ? 0 : 1)
    // A logo the browser could not load (including a refused insecure redirect) is
    // retried through the wallet route, which applies the same checks; one that was
    // fetched and rejected is not.
    expect(proxyRequests).toBe(failure === 'unreadable' || failure === 'redirect' ? 1 : 0)
  })
}

test('loads the logo through the wallet route when the host sends no CORS headers', async ({ page }) => {
  const proxied: URL[] = []
  await page.route('https://circle.com/.well-known/stellar.toml', (route) => route.fulfill({
    contentType: 'text/plain', body: `[[CURRENCIES]]\ncode="USDC"\nissuer="${issuer}"\nimage="https://logos.example/usdc.svg"`,
  }))
  await page.route('https://logos.example/**', (route) => route.abort())
  await page.route('**/api/issuer-logo?**', (route) => {
    proxied.push(new URL(route.request().url()))
    return route.fulfill({ contentType: 'image/svg+xml', body: logo })
  })
  await page.goto('/assets')
  const verified = page.locator('.card').filter({ hasText: 'Issuer: Circle' })
  await expect(verified.locator('img')).toHaveJSProperty('naturalWidth', 36)
  expect(proxied).toHaveLength(1)
  expect(Object.fromEntries(proxied[0].searchParams)).toEqual({ code: 'USDC', issuer })
})

test('does not request TOML for unregistered trustlines', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('veil_network', 'testnet'))
  await page.addInitScript((secret) => sessionStorage.setItem('veil_signer_secret', secret),
    Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).secret())
  await page.route('https://horizon-testnet.stellar.org/**', (route) => route.fulfill({
    json: { account_id: route.request().url().split('/').pop(), sequence: '1', balances: [
      { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: unknownIssuer, balance: '0', limit: '1000' },
    ] },
  }))
  const requests: string[] = []
  await page.route('**/.well-known/stellar.toml', (route) => { requests.push(route.request().url()); return route.abort() })
  await page.goto('/assets')
  await expect(page.getByText(unknownIssuer, { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText(unknownIssuer, { exact: true })).toBeVisible()
  expect(requests).toEqual([])
})
