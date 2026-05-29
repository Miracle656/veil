# End-to-End Tests

This directory contains Playwright E2E tests for the Veil wallet PWA.

## Test Files

### `onboarding.spec.ts`
Tests the initial wallet creation and onboarding flow:
- Landing page rendering
- Wallet creation with WebAuthn
- Tutorial overlay
- Existing wallet redirect to lock screen

### `happy-path.spec.ts`
Tests the complete user journey from registration to sending funds:
- Register a new wallet with WebAuthn (virtual authenticator)
- Fund the wallet via friendbot
- Send 1 XLM to a known address
- Verify the dashboard reflects the updated balance
- Wallet persistence across page reloads
- Error handling for failed transactions

### `multi-device.spec.ts`
Tests cross-device passkey sync:
- Register on device A (first browser context)
- Sign in on device B (second browser context) using synced credential
- Verify both contexts derive the same wallet contract address
- Demonstrates the "invisible" UX of passkey sync

## Helper Files

### `_authenticator.ts`
Utilities for managing virtual WebAuthn authenticators:
- `addVirtualAuthenticator()` - Create a virtual authenticator
- `getCredentials()` - Retrieve credentials from an authenticator
- `addCredential()` - Sync a credential to another authenticator
- `removeCredential()` - Remove a specific credential
- `clearCredentials()` - Clear all credentials
- `setUserVerified()` - Control user verification state

## Running Tests

### Run all E2E tests
```bash
npm run test:e2e
```

### Run a specific test file
```bash
npx playwright test e2e/happy-path.spec.ts
```

### Run tests in headed mode (see the browser)
```bash
npx playwright test --headed
```

### Run tests in debug mode
```bash
npx playwright test --debug
```

### Run tests in a specific browser
```bash
npx playwright test --project=chromium
```

## CI Integration

The tests are configured to run in CI via GitHub Actions. See `.github/workflows/wallet-e2e.yml`.

In CI mode:
- Tests run headlessly
- Retries are enabled (2 retries on failure)
- Screenshots and traces are captured on failure
- Results are uploaded as artifacts

## Test Architecture

### Virtual Authenticators
All tests use Playwright's Chrome DevTools Protocol (CDP) to create virtual WebAuthn authenticators. This allows testing passkey flows without physical biometric hardware.

### Network Stubbing
Tests stub network calls to:
- Friendbot (funding)
- Horizon (account data)
- Soroban RPC (contract interactions)

This makes tests fast, reliable, and independent of live testnet infrastructure.

### Multi-Context Testing
The `multi-device.spec.ts` tests use multiple browser contexts to simulate different devices. Credentials are "synced" by copying them between virtual authenticators using CDP.

## Debugging Tips

### View test traces
After a test failure, view the trace:
```bash
npx playwright show-trace test-results/[test-name]/trace.zip
```

### Take screenshots manually
```typescript
await page.screenshot({ path: 'debug.png' });
```

### Pause execution
```typescript
await page.pause();
```

### Console logs
Check browser console logs:
```typescript
page.on('console', msg => console.log('BROWSER:', msg.text()));
```

## Writing New Tests

1. Import helpers from `_authenticator.ts`
2. Use `addVirtualAuthenticator()` in `beforeEach` or test setup
3. Stub network calls with `page.route()`
4. Use semantic selectors (roles, labels) over CSS selectors
5. Add generous timeouts for WebAuthn operations (they can be slow)
6. Clean up storage in `beforeEach`:
   ```typescript
   await page.evaluate(() => {
     localStorage.clear();
     sessionStorage.clear();
   });
   ```

## Known Issues

- WebAuthn operations can be slow in CI (30s timeouts recommended)
- Virtual authenticators don't support all CTAP2 features
- Cross-origin iframes may require additional CDP configuration

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [WebAuthn Spec](https://www.w3.org/TR/webauthn-2/)
- [Chrome DevTools Protocol - WebAuthn](https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/)
