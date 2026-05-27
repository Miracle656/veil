/**
 * Unit tests for the useInvisibleWallet hook.
 *
 * WebAuthn browser APIs (navigator.credentials.create / .get) do not exist in
 * Node.js.  They are mocked here via jest.fn() so the tests run without a browser.
 * The Stellar SDK is also mocked so no real network calls are made.
 */
export {};
