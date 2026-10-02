# Contributing to Veil SDK

This document describes the development and testing workflows specific to the Veil client SDK.

## Testing

The SDK is tested using a combination of unit tests (via Vitest/Jest) and end-to-end browser compatibility tests (via Playwright).

### Unit Tests

To run the unit tests:

```bash
npm test
```

### Browser Compatibility Matrix Tests

WebAuthn behaves differently across Safari, Firefox, and Chrome. To ensure the SDK's happy-path works reliably across all three major browser engines (Chromium, Firefox, Webkit), we run browser matrix tests using Playwright.

These tests use a high-fidelity WebAuthn mock injected into the browser context, allowing us to test registration and signing without requiring physical hardware authenticators.

#### Prerequisites

Before running the browser matrix tests for the first time, make sure you have the required Playwright browsers installed:

```bash
npx playwright install --with-deps
```

#### Running the Tests

To run the browser matrix tests locally:

```bash
npx playwright test
```

To run a specific browser/project:

```bash
npx playwright test --project=chromium
npx playwright test --project=firefox
npx playwright test --project=webkit
```

To open the HTML report after running the tests:

```bash
npx playwright show-report
```
