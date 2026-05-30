# Veil Invisible Wallet — Expo Example

Minimal Expo app demonstrating `invisible-wallet-sdk` on React Native.

## Platform requirements

| Platform | Minimum version | Passkey support |
|----------|----------------|-----------------|
| iOS      | 16.0+          | Native (Face ID / Touch ID) |
| Android  | 13+ (API 33)   | FIDO2 credential manager |

> **Physical device required.** Passkeys do not work on simulators or emulators.

## Quick start

```bash
# 1. Install dependencies
cd examples/expo
npm install

# 2. Configure environment
cp .env.example .env.local
# Edit .env.local with your factory address and RP ID

# 3. Run on device
npx expo run:ios      # or: npx expo run:android
```

## Associated domain setup

Passkeys require your app to be associated with a web domain:

### iOS (`apple-app-site-association`)

Host this at `https://<your-domain>/.well-known/apple-app-site-association`:

```json
{
  "webcredentials": {
    "apps": ["<TEAM_ID>.<BUNDLE_ID>"]
  }
}
```

Set `rpId` in the config to match `<your-domain>`.

### Android (`assetlinks.json`)

Host this at `https://<your-domain>/.well-known/assetlinks.json`:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls",
               "delegate_permission/common.get_login_creds"],
  "target": {
    "namespace": "android_app",
    "package_name": "<your.package.name>",
    "sha256_cert_fingerprints": ["<SHA256>"]
  }
}]
```

## SDK configuration for React Native

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useInvisibleWallet } from 'invisible-wallet-sdk';

const wallet = useInvisibleWallet({
  factoryAddress:    'CABC...',
  rpcUrl:            'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpId:              'your-domain.com',   // required on React Native
  origin:            'https://your-domain.com', // required on React Native
  storage:           AsyncStorage,        // replaces localStorage
});
```

## Metro resolution

The SDK ships `src/webauthn.native.ts`. Metro automatically prefers `.native.ts`
over `.ts`, so no extra Babel configuration is needed when consuming from source.

The `metro.config.js` in this example also sets `extraNodeModules` to resolve
`invisible-wallet-sdk` from the monorepo's `sdk/` directory without publishing.