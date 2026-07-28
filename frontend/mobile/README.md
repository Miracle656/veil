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

- `app/_layout.tsx` — root Stack navigator (expo-router) wrapped in the connectivity provider.
- `app/index.tsx` — placeholder home route.
- `app/offline.tsx` — offline screen, shown automatically when connectivity drops.
- `lib/connectivity.tsx` — NetInfo-backed provider, `useConnectivity()` hook.
- `lib/outbox.ts` — durable queue of actions taken while offline.

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
