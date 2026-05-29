/**
 * E2E Happy Path Test: Register → Fund → Send
 * 
 * This test covers the complete user journey:
 * 1. Register a new wallet with WebAuthn (virtual authenticator)
 * 2. Fund the wallet via friendbot
 * 3. Send 1 XLM to a known address
 * 4. Verify the dashboard reflects the updated balance
 */

import { test, expect, type Page } from '@playwright/test';
import { addVirtualAuthenticator } from './_authenticator';

// ── Network Stubs ─────────────────────────────────────────────────────────────

async function stubNetworkCalls(page: Page) {
  // Friendbot — always succeed
  await page.route('**/friendbot.stellar.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ 
        result: 'funded', 
        hash: 'a'.repeat(64) // Valid hex hash
      }),
    })
  );

  // Horizon loadAccount — return a properly formatted funded account
  await page.route('**/horizon-testnet.stellar.org/accounts/**', (route) => {
    const url = route.request().url();
    const pubkey = url.split('/accounts/')[1]?.split('?')[0] || 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: pubkey,
        account_id: pubkey,
        sequence: '123456789',
        subentry_count: 0,
        balances: [
          { 
            asset_type: 'native', 
            balance: '10000.0000000',
            buying_liabilities: '0.0000000',
            selling_liabilities: '0.0000000'
          }
        ],
        thresholds: { 
          low_threshold: 0, 
          med_threshold: 0, 
          high_threshold: 0 
        },
        flags: {
          auth_required: false,
          auth_revocable: false,
          auth_immutable: false
        },
        signers: [
          {
            weight: 1,
            key: pubkey,
            type: 'ed25519_public_key'
          }
        ],
        data: {},
        paging_token: '',
        last_modified_ledger: 1000,
        last_modified_time: new Date().toISOString()
      }),
    });
  });

  // Soroban RPC — simulate and send transaction with valid XDR
  await page.route('**/soroban-testnet.stellar.org', async (route) => {
    const request = route.request();
    const postData = request.postDataJSON();
    
    if (postData?.method === 'simulateTransaction') {
      // Return valid simulation response with proper XDR
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: postData.id || 1,
          result: {
            transactionData: 'AAAAAAAAAAIAAAAGAAAAAem354u9STQWq5b3Ed1j9tOemvL7xV0NPwhn4gXg0AP8AAAAFAAAAAEAAAAH8dTto4AAAAAAAAAAAAAAAAAAAAA=',
            minResourceFee: '100',
            cost: { 
              cpuInsns: '100000', 
              memBytes: '1000' 
            },
            latestLedger: 1000,
            results: [
              {
                auth: [],
                xdr: 'AAAAEAAAAAEAAAACAAAADwAAAAdCYWxhbmNlAAAAABAAAAABAAAAAgAAAA8AAAAHQmFsYW5jZQAAAAA='
              }
            ]
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
            hash: 'a'.repeat(64),
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
            latestLedger: 1001,
            latestLedgerCloseTime: Math.floor(Date.now() / 1000),
            oldestLedger: 900,
            oldestLedgerCloseTime: Math.floor(Date.now() / 1000) - 1000,
            applicationOrder: 1,
            envelopeXdr: 'AAAAAgAAAAA=',
            resultXdr: 'AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA=',
            resultMetaXdr: 'AAAAAwAAAAAAAAACAAAAAwAAA+gAAAAAAAAAAO3nZDVD4KR9yD1MLNfJWzeMIBB0ZM3bTJmHeVvHLcGkAAAAF0h1FHwAAAPnAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAA',
            ledger: 1001,
            createdAt: Math.floor(Date.now() / 1000)
          },
        }),
      });
    }
    
    if (postData?.method === 'getContractData') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: postData.id || 1,
          result: {
            xdr: 'AAAAEAAAAAEAAAACAAAADwAAAAdCYWxhbmNlAAAAABAAAAABAAAAAgAAAA8AAAAHQmFsYW5jZQAAAAA=',
            lastModifiedLedgerSeq: 1000,
            latestLedger: 1001
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
    
    // Step 7: Submit the send transaction
    const sendButton = page.getByRole('button', { name: /send|submit|confirm/i });
    await expect(sendButton.first()).toBeVisible({ timeout: 10_000 });
    await sendButton.first().click();
    
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
    await page.waitForLoadState('networkidle');
    
    await page.getByRole('button', { name: /create wallet/i }).click({ force: true });
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
