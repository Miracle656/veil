# Vue Composable Testing

## Manual Test Verification

The `@veil/invisible-wallet-vue` composable has been verified to:

### 1. Export the correct interface
- ✓ `useInvisibleWallet(config)` function exported
- ✓ All type definitions exported (WalletConfig, RegisterResult, etc.)
- ✓ Error classes exported (RecoveryTimelockActive, NoGuardianSet, RecoveryNotPending)

### 2. Provide parity with React hook
All methods from the React hook are available:
- ✓ register(username?)
- ✓ deploy(signerKeypair, publicKeyBytes?)
- ✓ login()
- ✓ signAuthEntry(payload)
- ✓ getNonce()
- ✓ addSigner(signerKeypair, publicKeyBytes)
- ✓ getSigners()
- ✓ removeSigner(signerKeypair, index)
- ✓ setGuardian(signerKeypair, guardianAddress)
- ✓ initiateRecovery(guardianKeypair, newPublicKeyBytes)
- ✓ completeRecovery(payerKeypair)
- ✓ getAllowance(spender, token)
- ✓ approve(signerKeypair, spender, token, amount, expiry?)

### 3. Provide reactive state
All state is provided as Vue reactive refs:
- ✓ address (readonly ref)
- ✓ isDeployed (readonly ref)
- ✓ isPending (readonly ref)
- ✓ error (readonly ref)

### 4. Core integration
- ✓ Uses InvisibleWalletCore class internally
- ✓ State callbacks properly update Vue refs
- ✓ Lifecycle hooks (onMounted, onUnmounted) handle initialization/cleanup

## Bundle Verification

The Vue package build configuration:
- ✓ Marks 'vue' as external (not bundled)
- ✓ Marks '@stellar/stellar-sdk' as external (not bundled)
- ✓ Marks 'invisible-wallet-sdk' as external (not bundled)
- ✓ Does NOT import React
- ✓ Only imports Vue from '@veil/invisible-wallet-vue'

## Usage Examples

See EXAMPLE.md for complete working examples including:
- Registration workflow
- Deployment workflow
- Authentication flow
- Multi-signature management
- Guardian recovery
- Spending limits

## Running Tests

```bash
cd sdk/vue
npm install
npm run build
```

The build output will be in `dist/` with no React dependencies.
