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

## Checks

```bash
npm run typecheck
npm test
```

`npm test` runs Jest through the `jest-expo` preset. Suites live next to the code
they cover, in `lib/__tests__/`.

## Theming

The app ships light and dark modes. `lib/theme.ts` holds the palette — a
`ThemeColors` record per theme — plus the active selection, persisted to
AsyncStorage under the same `veil_theme` key the web wallet uses.

Screens read colours through the `useTheme` hook and build their styles from
them:

```tsx
const { colors } = useTheme();
const styles = useMemo(() => createStyles(colors), [colors]);
```

Drop `<ThemeToggle />` anywhere to let the user switch; no provider is needed,
matching the web wallet's standalone `useTheme`. New screens should style from
`ThemeColors` roles rather than literal hex values, so light mode cannot be
forgotten.

## Encrypted backups

`/settings/backup` exports the wallet's non-secret state — address, signer public
keys, settings — as an AES-256-GCM envelope sealed with a user passphrase, then
hands the file to the system share sheet.

The same screen restores from a backup file: pick it, enter the passphrase, and
the decrypted wallet state is written back to device storage.

The envelope format is byte-compatible with `sdk/src/backup.ts`, so a file
exported on mobile restores in the web wallet and vice versa. Private key
material never enters a backup: `assertNoSecretMaterial` in `lib/backup.ts`
rejects the metadata before encryption if it finds a secret-looking field.

Every field of the envelope is authenticated. A backup opened with the wrong
passphrase, or altered by so much as a bit, fails with `BackupTamperError` and
changes nothing on the device — there is no partial restore.

## Structure

- `app/_layout.tsx` — root Stack navigator (expo-router) wrapped in the connectivity provider.
- `app/index.tsx` — placeholder home route.
- `app/offline.tsx` — offline screen, shown automatically when connectivity drops.
- `lib/connectivity.tsx` — NetInfo-backed provider, `useConnectivity()` hook.
- `lib/outbox.ts` — durable queue of actions taken while offline.
- `hooks/useTheme.ts`, `components/ThemeToggle.tsx`, `lib/theme.ts` — theming.
- `app/_layout.tsx` — root Stack navigator (expo-router).
- `app/index.tsx` — placeholder home route, with the Connect dApp entry point.
- `components/ConnectDAppModal.tsx` — scan or paste a WalletConnect URI.
- `hooks/useWalletConnect.ts` — React binding over the WalletConnect store.
- `lib/walletConnect.ts` — WalletConnect client, pairing, sessions and signing.
- `lib/walletConnectHelpers.ts` — pure parsing/validation helpers (unit-tested).
- `app/_layout.tsx` — root Stack navigator (expo-router), with the approval modal.
- `app/index.tsx` — placeholder home route, with the Connect dApp entry point.
- `components/ConnectDAppModal.tsx` — scan or paste a WalletConnect URI.
- `components/WalletConnectApprovalModal.tsx` — approve or reject dApp requests.
- `hooks/useWalletConnect.ts` — React binding over the WalletConnect store.
- `lib/walletConnect.ts` — WalletConnect client, pairing, sessions and signing.
- `lib/walletConnectHelpers.ts` — pure parsing/validation helpers (unit-tested).
- `lib/passkey.ts` — device passkey signer for dApp requests.
- `lib/webauthn.ts` — WebAuthn encoding and DER signature conversion (unit-tested).
- `lib/polyfills.ts` — React Native shims WalletConnect and the Stellar SDK need.

Native `ios/` and `android/` folders are generated on demand (via prebuild/EAS) and
are gitignored, along with `node_modules/` and `.expo/`.

## Tests

```bash
npm test        # jest-expo
npm run typecheck
```

## Connectivity and the offline outbox

`<ConnectivityProvider>` subscribes to `@react-native-community/netinfo` and exposes
the current network state through `useConnectivity()`. When NetInfo positively
reports no usable connection, the root layout pushes `/offline`; when connectivity
returns it pops back to the screen the user was on, so navigation state survives
the interruption. An unknown state (`isInternetReachable: null`, common while
NetInfo is still probing) is treated as online, so the offline screen never
flashes on a healthy connection.

Rather than letting a network call fail while offline, a screen queues the action:

```ts
import { useConnectivity } from '../lib/connectivity';

const { isOnline, enqueue } = useConnectivity();

if (!isOnline) {
  await enqueue('payment.send', { destination, amount });
  return;
}
```

Feature code registers the handler that actually performs the action. Registering
at module scope (or in a provider effect) means the handler is present whenever a
flush runs:

```ts
import { registerOutboxHandler } from '../lib/outbox';

registerOutboxHandler('payment.send', async (payload) => {
  await sendPayment(payload as SendPaymentInput);
});
```

The queue is persisted to `AsyncStorage`, so it survives an app restart. It is
flushed automatically on the offline → online transition, one action at a time in
the order it was queued. An action that throws stays queued with its attempt count
bumped and is retried on the next flush; after `MAX_ATTEMPTS` (5) it is dropped so
one permanently broken action cannot wedge everything behind it. Actions whose
`type` has no registered handler are dropped for the same reason.
## WalletConnect

The app pairs with external dApps over WalletConnect v2 so a user can approve web
app transactions from their phone. Set the project id from
[WalletConnect Cloud](https://cloud.walletconnect.com) before running:

```bash
# frontend/mobile/.env.local
EXPO_PUBLIC_WC_PROJECT_ID=your_project_id
EXPO_PUBLIC_NETWORK=testnet                   # or mainnet
EXPO_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
EXPO_PUBLIC_PASSKEY_RP_ID=veil.app            # domain the passkey is registered against
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

## dApp approval

`<WalletConnectApprovalModal />` is mounted once in `app/_layout.tsx`, so a
request from a connected dApp is presented wherever the user happens to be. It
reads the pending-request queue from `lib/walletConnect` and shows requests one
at a time, oldest first.

Each request is decoded far enough to judge it — payments show the amount and
destination, contract calls show the contract address and function name — and
anything that cannot be decoded is labelled an unknown contract interaction to
review carefully, never presented as safe. Nothing is signed until the user taps
**Approve**; **Reject** answers the dApp with a `USER_REJECTED` error so it fails
cleanly rather than hanging.

Approving runs the signing pipeline in `lib/walletConnect.ts`, which asks
`lib/passkey.ts` to sign each Soroban authorization entry. The
authorization-entry hash is passed as the WebAuthn challenge, so the assertion
the authenticator produces covers exactly the payload the wallet contract will
verify — there is no separate, decorative biometric prompt. Dismissing the
passkey sheet is treated as a rejection, not an error.

`lib/webauthn.ts` converts the assertion into what the contract expects: the DER
ECDSA signature becomes a raw 64-byte `r ‖ s` pair, with `s` normalised to low
form because Soroban's `secp256r1_verify` rejects the malleable high-S variant
that authenticators sometimes return.

Passkeys need platform association before they resolve on a device: an
`associatedDomains` entry (`webcredentials:<rp-id>`) for iOS and a matching
`assetlinks.json` on the domain for Android. `EXPO_PUBLIC_PASSKEY_RP_ID` must be
the same relying-party id the wallet's passkey was registered against.
