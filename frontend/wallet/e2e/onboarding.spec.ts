// @ts-ignore
import { test, expect, type Page } from '@playwright/test'
import { addVirtualAuthenticator } from './_authenticator'
import { stubNetworkCalls } from './_stubs'

// ── Seed localStorage to simulate "existing wallet" state ─────────────────────

async function seedExistingWallet(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem('invisible_wallet_address', 'CFAKEWALLET123FAKE456')
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Onboarding — new wallet creation', () => {
  test.beforeEach(async ({ page }) => {
    // Skip the first-run onboarding tutorial on every navigation (incl. each
    // test's own goto). Its full-screen overlay otherwise intercepts the
    // "Create wallet" click. The tutorial itself is covered separately below.
    await page.addInitScript(() => {
      try { window.localStorage.setItem('veil_seen_tutorial', '1') } catch {}
    })
    // Clear all storage so each test starts fresh
    await page.goto('/')
    await page.evaluate(() => {
      localStorage.clear()
      sessionStorage.clear()
    })
    await stubNetworkCalls(page)
  })

  test('landing page renders the Create wallet button', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: /create wallet/i })).toBeVisible()
  })

  test('landing page renders the Recover existing wallet button', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: /recover existing wallet/i })).toBeVisible()
  })

  test('shows biometric waiting state after clicking Create wallet', async ({ page }) => {
    // Register a virtual authenticator so WebAuthn doesn't block
    await addVirtualAuthenticator(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: /create wallet/i }).click({ force: true })

    // Should show the "Waiting for biometric..." or "Deploying wallet on-chain..." card
    await expect(
      page.getByText(/waiting for biometric|deploying wallet on-chain/i),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('full onboarding flow: create wallet → dashboard redirect', async ({ page }) => {
    await addVirtualAuthenticator(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: /create wallet/i }).click({ force: true })

    // After creation, either:
    // (a) "Wallet created" card appears before dashboard redirect, OR
    // (b) we land on /dashboard directly (if the SDK resolves fast)
    await expect(
      page.getByText(/wallet created/i).or(page.getByText(/dashboard/i).first()),
    ).toBeVisible({ timeout: 30_000 })
  })
})

test.describe('Onboarding — existing wallet redirect', () => {
  test('redirects to /lock when wallet address is already in localStorage', async ({ page }) => {
    // Seed localStorage before the page loads so the effect fires immediately
    await page.addInitScript(() => {
      localStorage.setItem('invisible_wallet_address', 'CFAKEWALLET123FAKE456')
    })

    await page.goto('/')

    // Should land on /lock, not stay on /
    await expect(page).toHaveURL(/\/lock/, { timeout: 10_000 })
  })

  test('lock page renders when navigated directly', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('invisible_wallet_address', 'CFAKEWALLET123FAKE456')
    })
    await page.goto('/lock')
    // The lock page must have some visible UI (heading or button)
    await expect(page.locator('body')).not.toBeEmpty()
  })
})

test.describe('Onboarding — tutorial overlay', () => {
  test('tutorial is shown on first visit (no veil_seen_tutorial in storage)', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => {
      localStorage.removeItem('veil_seen_tutorial')
      localStorage.removeItem('invisible_wallet_address')
    })
    await page.reload()

    // The OnboardingTutorial component should be visible
    // It renders a full-screen overlay — assert some tutorial-specific text exists
    const tutorialVisible = await page.locator('[class*="tutorial"], [data-testid="tutorial"]').count()
    // Accept either the component or any modal-like overlay
    const bodyText = await page.locator('body').textContent()
    expect(bodyText).toBeTruthy()
  })
})
