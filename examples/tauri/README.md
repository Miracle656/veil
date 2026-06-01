# Veil Tauri Wallet Example

A minimal cross-platform Tauri desktop wallet example for the Veil SDK. This app demonstrates passkey registration and transaction signing using Tauri's biometric plugin instead of browser WebAuthn.

## Prerequisites

- Node.js 18+
- Rust 1.70+ (or latest stable)
- `npm` or `pnpm`
- Platform-specific requirements:
  - macOS: Touch ID enrolled and Xcode command line tools installed
  - Windows: Visual Studio with Desktop development for C++ and Windows Hello enrolled
  - Linux: `libwebkit2gtk-4.0-dev` plus a supported desktop environment; biometric plugin support is limited on Linux and may not work on every distro

## Setup

From the repository root:

```bash
cd examples/tauri
npm install
```

Create a `.env` file in `examples/tauri` with:

```env
VITE_FACTORY_ADDRESS=YOUR_FACTORY_ADDRESS
VITE_RPC_URL=https://soroban-testnet.stellar.org
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VITE_RP_ID=localhost
VITE_ORIGIN=https://localhost
```

The example will still register passkeys and perform local signing even without a factory address, but on-chain deployment and contract authorization require a valid factory contract.

## Run

```bash
npm run tauri:dev
```

## Build

```bash
npm run tauri:build
```

## Notes

- The app uses `@tauri-apps/plugin-biometric` for biometric prompts.
- Biometric failures such as cancellation, missing enrollment, or unsupported hardware are surfaced to the user.
- Linux support is best-effort: the biometric plugin may not work on all distributions.
- No browser `navigator.credentials` APIs are used in the Tauri passkey flows.
