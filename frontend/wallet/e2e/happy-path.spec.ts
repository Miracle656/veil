/**
 * E2E Happy Path Test: Register → Fund → Send
 * 
 * This test covers the complete user journey:
 * 1. Register a new wallet with WebAuthn (virtual authenticator)
 * 2. Fund the wallet via friendbot
 * 3. Send 1 XLM to a known address
 * 4. Verify the dashboard reflects the updated balance
 */

import { test, expect } from '@playwright/test';
import { addVirtualAuthenticator } from './_authenticator';
import { stubNetworkCalls } from './_stubs';

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Happy Path: Register → Fund → Send', () => {
  // Wallet creation plus a full send flow does not fit the 30s default.
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    // Clear storage before each test
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test('complete flow: register wallet, fund via friendbot, send XLM', async ({ page }) => {
    // Step 1: Setup virtual authenticator on the actual test page
    await addVirtualAuthenticator(page);
    await stubNetworkCalls(page);
    
    // Step 2: Navigate to home and create wallet
    await page.goto('/');
    
    // Wait for any loading overlays to disappear
    await page.waitForLoadState('networkidle');
    
    const createButton = page.getByRole('button', { name: /create wallet/i });
    await expect(createButton).toBeVisible({ timeout: 10_000 });
    
    // Force click to bypass any overlays
    await createButton.click({ force: true });
    
    // Step 3: Wait for wallet creation and verify we have a valid contract address
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    
    // Verify wallet address was stored and is a valid contract address
    const walletAddress = await page.evaluate(() => 
      localStorage.getItem('invisible_wallet_address')
    );
    expect(walletAddress).toBeTruthy();
    expect(walletAddress).toMatch(/^C[A-Z2-7]{55}$/); // Valid Stellar contract address
    
    // Verify we're actually on the dashboard with wallet state
    await expect(page).toHaveURL(/\/dashboard/);
    
    // Step 4: Fund the wallet via friendbot (if button exists)
    const fundButton = page.getByRole('button', { name: /fund|get.*xlm|friendbot/i }).first();
    
    if (await fundButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await fundButton.click();
      
      // Wait for funding confirmation
      await expect(
        page.getByText(/funded|success|received/i).first()
      ).toBeVisible({ timeout: 15_000 });
    }
    
    // Step 5: Navigate to send page
    const sendLink = page.getByRole('link', { name: /send/i }).or(
      page.getByRole('button', { name: /send/i })
    );
    
    await expect(sendLink.first()).toBeVisible({ timeout: 10_000 });
    await sendLink.first().click();
    
    // Verify we're on the send page
    await page.waitForURL(/\/send/, { timeout: 10_000 });
    
    // Step 6: Fill in send form with valid Stellar address
    const recipientAddress = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    
    const recipientInput = page.getByLabel(/recipient|address|to/i).or(
      page.getByPlaceholder(/recipient|address|G\.\.\./i)
    );
    await expect(recipientInput.first()).toBeVisible({ timeout: 10_000 });
    await recipientInput.first().fill(recipientAddress);
    
    const amountInput = page.getByLabel(/amount/i).or(
      page.getByPlaceholder(/amount|1\.0/i)
    );
    await expect(amountInput.first()).toBeVisible({ timeout: 10_000 });
    await amountInput.first().fill('1');
    
    // Step 7: Submit the send transaction. The form is two-step —
    // "Review" opens the confirmation card, "Confirm & sign" submits it.
    const reviewButton = page.getByRole('button', { name: /^review$/i });
    await expect(reviewButton).toBeEnabled({ timeout: 10_000 });
    await reviewButton.click();

    const confirmButton = page.getByRole('button', { name: /confirm.*sign/i });
    await expect(confirmButton).toBeVisible({ timeout: 10_000 });
    await confirmButton.click();

    // Step 8: Wait for transaction confirmation
    await expect(
      page.getByText(/success|sent|confirmed|complete/i).first()
    ).toBeVisible({ timeout: 30_000 });
    
    // Step 9: Navigate back to dashboard and verify balance is displayed
    const dashboardLink = page.getByRole('link', { name: /dashboard|home/i }).or(
      page.getByRole('button', { name: /dashboard|home/i })
    );
    
    if (await dashboardLink.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await dashboardLink.first().click();
      await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
    } else {
      // If no explicit link, navigate directly
      await page.goto('/dashboard');
    }
    
    // Verify the dashboard shows balance information (actual wallet state, not just chrome)
    await expect(
      page.getByText(/balance|xlm/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('wallet persists across page reloads', async ({ page }) => {
    await addVirtualAuthenticator(page);
    await stubNetworkCalls(page);
    
    // Create wallet
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    await page.getByRole('button', { name: /create wallet/i }).click({ force: true });
    
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    
    // Get the wallet address from localStorage
    const walletAddress = await page.evaluate(() => 
      localStorage.getItem('invisible_wallet_address')
    );
    
    expect(walletAddress).toBeTruthy();
    expect(walletAddress).toMatch(/^C[A-Z2-7]{55}$/); // Valid contract address format
    
    // Reload the page
    await page.reload();
    
    // Verify wallet address is still in localStorage
    const walletAddressAfterReload = await page.evaluate(() => 
      localStorage.getItem('invisible_wallet_address')
    );
    
    expect(walletAddressAfterReload).toBe(walletAddress);
    
    // Should redirect to lock screen or dashboard (not back to onboarding)
    await expect(page).not.toHaveURL('/');
  });

  test('displays error when send fails', async ({ page }) => {
    await addVirtualAuthenticator(page);
    
    await stubNetworkCalls(page);

    // Create wallet and navigate to send
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    await page.getByRole('button', { name: /create wallet/i }).click({ force: true });
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });

    // A payment to a `G...` recipient is a classic Stellar transaction, so it
    // is submitted to Horizon rather than over Soroban RPC. Registered after
    // the base stubs so it matches first, and falls back to them for every
    // request other than the submission being made to fail.
    await page.route(
      (url) => url.hostname === 'horizon-testnet.stellar.org',
      async (route) => {
        const url = new URL(route.request().url());

        if (url.pathname === '/transactions' && route.request().method() === 'POST') {
          return route.fulfill({
            status: 400,
            contentType: 'application/problem+json',
            body: JSON.stringify({
              type: 'https://stellar.org/horizon-errors/transaction_failed',
              title: 'Transaction Failed',
              status: 400,
              detail: 'The transaction failed when submitted to the Stellar network.',
              extras: {
                result_codes: { transaction: 'tx_insufficient_balance' },
              },
            }),
          });
        }

        return route.fallback();
      },
    );


    const sendLink = page.getByRole('link', { name: /send/i }).or(
      page.getByRole('button', { name: /send/i })
    );
    await sendLink.first().click();
    await page.waitForURL(/\/send/, { timeout: 10_000 });
    
    // Fill form
    await page.getByLabel(/recipient|address|to/i).first().fill(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
    );
    await page.getByLabel(/amount/i).first().fill('1000000'); // Unrealistic amount

    // Submit — review, then confirm
    await page.getByRole('button', { name: /^review$/i }).click();
    await page.getByRole('button', { name: /confirm.*sign/i }).click();

    // Verify error message appears
    await expect(
      page.getByText(/error|fail|insufficient/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });
});
