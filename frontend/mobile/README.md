# Veil Mobile

Expo (expo-router + TypeScript) mobile app for Veil. This is the bootable shell —
a single placeholder home route (`app/index.tsx`) proving the toolchain runs. No
wallet logic or SDK is wired up yet.

## Getting started

```bash
cd frontend/mobile
npm install
npx expo start
```

Then press `i` for the iOS simulator, `a` for the Android emulator, or `w` for web.

## Structure

- `app/_layout.tsx` — root Stack navigator (expo-router).
- `app/index.tsx` — placeholder home route, with the Connect dApp entry point.
- `components/ConnectDAppModal.tsx` — scan or paste a WalletConnect URI.
- `hooks/useWalletConnect.ts` — React binding over the WalletConnect store.
- `lib/walletConnect.ts` — WalletConnect client, pairing, sessions and signing.
- `lib/walletConnectHelpers.ts` — pure parsing/validation helpers (unit-tested).
- `lib/polyfills.ts` — React Native shims WalletConnect and the Stellar SDK need.

Native `ios/` and `android/` folders are generated on demand (via prebuild/EAS) and
are gitignored, along with `node_modules/` and `.expo/`.

## Tests

```bash
npm test        # jest-expo
npm run typecheck
```

## WalletConnect

The app pairs with external dApps over WalletConnect v2 so a user can approve web
app transactions from their phone. Set the project id from
[WalletConnect Cloud](https://cloud.walletconnect.com) before running:

```bash
# frontend/mobile/.env.local
EXPO_PUBLIC_WC_PROJECT_ID=your_project_id
EXPO_PUBLIC_NETWORK=testnet                   # or mainnet
EXPO_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

Tap **Connect dApp** on the home screen, then either scan the dApp's QR code or
paste its `wc:` URI. A pasted or scanned deep link that wraps the pairing URI in a
query parameter is unwrapped automatically. Once the dApp sends its session
proposal the sheet shows who is asking and what they get, and the session is only
established after an explicit approve.

Sessions are namespaced to `stellar:testnet` or `stellar:pubnet` depending on
`EXPO_PUBLIC_NETWORK`, and advertise `stellar_signXDR` and
`stellar_signAndSubmitXDR`.

### React Native specifics

WalletConnect and the Stellar SDK both assume browser or Node globals that Hermes
does not provide, so `lib/polyfills.ts` is imported first by `lib/walletConnect.ts`:

- `@walletconnect/react-native-compat` — must be evaluated before the
  WalletConnect core, which reads `TextEncoder`, `URL` and async storage at import
  time.
- `react-native-get-random-values` — `crypto.getRandomValues` for key material.
- `react-native-url-polyfill/auto` and `buffer` — URL parsing and XDR encoding.

Hashing uses `expo-crypto` rather than `crypto.subtle`, which Hermes lacks. The
fee-payer secret and wallet address live in the OS keychain via
`expo-secure-store` (`lib/walletStore.ts`) instead of web storage.

### Signing

`lib/walletConnect.ts` does not implement passkey signing itself. Feature code
registers a signer, which is called once per Soroban authorization entry and
returns null when the user declines:

```ts
import { registerAuthEntrySigner } from '../lib/walletConnect';

registerAuthEntrySigner(async (payloadHash) => signWithPasskey(payloadHash));
```

Incoming `session_request` events are held in a subscribable queue
(`subscribeWalletConnectRequests`) rather than fired as one-shot events, so an
approval UI that mounts after the request still sees it. Every request is answered
exactly once — with a result, a `USER_REJECTED` error when the user declines, or a
generic error otherwise — so a dApp never hangs waiting on a reply.
