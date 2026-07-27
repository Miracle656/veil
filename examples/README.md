# Examples

This directory contains example implementations of the Invisible Wallet SDK.

## SvelteKit

The `sveltekit/` directory contains a complete SvelteKit application demonstrating the Svelte adapter with a writable store.

### Running the SvelteKit example

1. Install dependencies:
   ```bash
   cd examples/sveltekit
   pnpm install
   ```

2. Start the development server:
   ```bash
   pnpm dev
   ```

3. Open http://localhost:5173 in your browser

### Features demonstrated

- Register a new passkey credential
- Deploy a wallet contract on Stellar testnet
- Login with existing credentials
- Send XLM transfers with biometric authentication
- Reactive wallet state using Svelte stores

### Requirements

- Node.js 18+
- pnpm
- Modern browser with WebAuthn support (Chrome, Firefox, Safari, Edge)
- HTTPS or localhost (required for WebAuthn)

## Vanilla JavaScript

The `vanilla/` directory contains a complete HTML page demonstrating how to use the SDK without any framework dependencies.

### Running the vanilla example

1. Build the SDK:
   ```bash
   cd sdk
   npm run build
   ```

2. Serve the HTML file:
   ```bash
   cd examples/vanilla
   python -m http.server 8000
   # or use any static file server
   ```

3. Open http://localhost:8000 in your browser

### Features demonstrated

- Register a new passkey credential
- Deploy a wallet contract on Stellar testnet
- Login with existing credentials
- Sign test payloads with biometric authentication

### Requirements

- Modern browser with WebAuthn support (Chrome, Firefox, Safari, Edge)
- HTTPS or localhost (required for WebAuthn)
- A Stellar testnet account with XLM for transaction fees
