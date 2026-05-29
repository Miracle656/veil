# Vue 3 Example Setup

This directory contains the SDK packages. To create a Vue 3 example application:

## Quick Start with Vite

```bash
# Create a new Vite project
npm create vite@latest my-invisible-wallet-app -- --template vue-ts

# Navigate to the project
cd my-invisible-wallet-app

# Install dependencies
npm install

# Add Invisible Wallet packages
npm install invisible-wallet-sdk @veil/invisible-wallet-vue @stellar/stellar-sdk
```

## Or, Install from Local SDK

If you're developing locally:

```bash
cd sdk
npm install

cd ../sdk/vue
npm install

# Link packages (if using npm link or workspace)
npm link
cd ../../../my-app
npm link @veil/invisible-wallet-vue invisible-wallet-sdk
```

## Example Component

See `EXAMPLE.md` in the sdk/vue directory for a complete working example component.

## Features

✓ Vue 3 Composition API composable
✓ Reactive state management
✓ WebAuthn passkey authentication
✓ Stellar Soroban integration
✓ Multiple signer support
✓ Guardian-based key recovery
✓ Spending limits (allowance system)

## Files

- `sdk/src/` - Core SDK (framework-agnostic)
- `sdk/src/useInvisibleWallet.ts` - React hook
- `sdk/vue/src/useInvisibleWallet.ts` - Vue composable
- `sdk/vue/EXAMPLE.md` - Complete Vue example with code snippets
