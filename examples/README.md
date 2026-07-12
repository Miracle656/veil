# Examples

This directory contains example implementations of the Invisible Wallet SDK.

## Vanilla JavaScript

The `vanilla/` directory contains a complete HTML page demonstrating how to use the SDK without any framework dependencies.

## Discord Faucet

The `discord-faucet/` directory contains a `discord.js` bot that registers a
`/faucet` slash command and sends 10 testnet XLM to a requester-provided Stellar
account with per-user rate limiting.

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

## AI Tipping Agent

The `agent-tip-bot/` directory contains an autonomous Claude-powered agent that scores creator posts and tips the best ones with XLM on Stellar testnet.

See [agent-tip-bot/README.md](agent-tip-bot/README.md) for setup and usage.
