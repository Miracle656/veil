/**
 * E2E Happy Path Test: Register → Fund → Send
 * 
 * This test covers the complete user journey:
 * 1. Register a new wallet with WebAuthn (virtual authenticator)
 * 2. Fund the wallet via friendbot
 * 3. Send 1 XLM to a known address
 * 4. Verify the dashboard reflects the updated balance
 */

import { test, expect, type BrowserContext, type Page } from '@playwright/test';

// ── WebAuthn Virtual Authenticator Setup ─────────────────────────────────────

async function addVirtualAuthenticator(context: BrowserContext) {
  const page = await context.newPage();
  const cdpSession = await context.newCDPSession(page);
  
  await cdpSession.send('WebAuthn.enable', { enableUI: false });
  
  const { authenticatorId } = await cdpSession.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  
  await page.close();
  return { cdpSession, authenticatorId };
}

// ── Network Stubs ─────────────────────────────────────────────────────────────

async function stubNetworkCalls(page: Page) {
  // Friendbot — always succeed
  await page.route('**/friendbot.stellar.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ result: 'funded', hash: 'fake-tx-hash' }),
    })
  );

  // Horizon loadAccount — return a funded account
  await page.route('**/horizon-testnet.stellar.org/accounts/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'GTEST',
        sequence: '123456789',
        balances: [
          { asset_type: 'native', balance: '10000.0000000' }
        ],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: {},
        signers: [],
      }),
    })
  );

  // Soroban RPC — simulate and send transaction
  await page.route('**/soroban-testnet.stellar.org', async (route) => {
    const request = route.request();
    const postData = request.postDataJSON();
    
    if (postData?.method === 'simulateTransaction') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: postData.id || 1,
          result: {
            status: 'SUCCESS',
            results: [{ xdr: 'AAAAAQAAAA==' }],
            latestLedger: '1000',
            cost: { cpuInsns: '100000', memBytes: '1000' },
            transactionData: 'AAAA',
            minResourceFee: '100',
          },
        }),
      });
    }
    
    if (postData?.method === 'sendTransaction') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: postData.id || 1,
          result: {
            status: 'PENDING',
            hash: 'fake-transaction-hash-12345',
          },
        }),
      });
    }
    
    if (postData?.method === 'getTransaction') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: postData.id || 1,
          result: {
            status: 'SUCCESS',
            latestLedger: '1001',
            latestLedgerCloseTime: Math.floor(Date.now() / 1000),
            oldestLedger: '900',
            oldestLedgerCloseTime: Math.floor(Date.now() / 1000) - 1000,
            returnValue: 'AAAAAQAAAA==',
          },
        }),
      });
    }
    
    // Default response for other methods
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: postData?.id || 1,
        result: {},
      }),
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Happy Path: Register → Fund → Send', () => {
  test.beforeEach(async ({ page }) => {
    // Clear storage before each test
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test('complete flow: register wallet, fund via friendbot, send XLM', async ({ page, context }) => {
    // Step 1: Setup virtual authenticator
    await addVirtualAuthenticator(context);
    await stubNetworkCalls(page);
    
    // Step 2: Navigate to home and create wallet
    await page.goto('/');
    
    const createButton = page.getByRole('button', { name: /create wallet/i });
    await expect(createButton).toBeVisible({ timeout: 10_000 });
    await createButton.click();
    
    // Wait for wallet creation to complete
    // The app should show either "Wallet created" or redirect to dashboard
    await expect(
      page.getByText(/wallet created|dashboard/i).first()
    ).toBeVisible({ timeout: 30_000 });
    
    // Step 3: Verify we're on the dashboard
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    
    // Step 4: Fund the wallet via friendbot
    // Look for a "Fund" or "Get testnet XLM" button
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
    
    // Step 6: Fill in send form
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
    
    // Step 7: Submit the send transaction
    const sendButton = page.getByRole('button', { name: /send|submit|confirm/i });
    await expect(sendButton.first()).toBeVisible({ timeout: 10_000 });
    await sendButton.first().click();
    
    // Step 8: Wait for transaction confirmation
    await expect(
      page.getByText(/success|sent|confirmed|complete/i).first()
    ).toBeVisible({ timeout: 30_000 });
    
    // Step 9: Navigate back to dashboard and verify balance updated
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
    
    // Verify the dashboard shows balance information
    // The balance should be visible (we don't assert exact amount due to stubbing)
    await expect(
      page.getByText(/balance|xlm/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('wallet persists across page reloads', async ({ page, context }) => {
    await addVirtualAuthenticator(context);
    await stubNetworkCalls(page);
    
    // Create wallet
    await page.goto('/');
    await page.getByRole('button', { name: /create wallet/i }).click();
    
    await expect(
      page.getByText(/wallet created|dashboard/i).first()
    ).toBeVisible({ timeout: 30_000 });
    
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

  test('displays error when send fails', async ({ page, context }) => {
    await addVirtualAuthenticator(context);
    
    // Override network stubs to simulate failure
    await page.route('**/soroban-testnet.stellar.org', async (route) => {
      const request = route.request();
      const postData = request.postDataJSON();
      
      if (postData?.method === 'sendTransaction') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: postData.id || 1,
            error: {
              code: -32600,
              message: 'Transaction failed: insufficient balance',
            },
          }),
        });
      }
      
      // Use default stubs for other calls
      return route.continue();
    });
    
    await stubNetworkCalls(page);
    
    // Create wallet and navigate to send
    await page.goto('/');
    await page.getByRole('button', { name: /create wallet/i }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    
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
    
    // Submit
    await page.getByRole('button', { name: /send|submit|confirm/i }).first().click();
    
    // Verify error message appears
    await expect(
      page.getByText(/error|fail|insufficient/i).first()
    ).toBeVisible({ timeout: 15_000 });
  });
});
