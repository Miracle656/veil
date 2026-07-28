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

## Networks

`EXPO_PUBLIC_NETWORK` sets the network a build defaults to (`testnet` or
`mainnet`). From `/settings/network` the user can override it at runtime; the
choice is persisted and survives restarts, so testers do not need a new build to
move between chains.

`lib/network.ts` resolves the active network — persisted override, then
`EXPO_PUBLIC_NETWORK`, then testnet — and exposes it synchronously via
`getNetwork()`. Anything holding network-dependent state should subscribe with
`subscribeToNetwork` (or the `useNetwork` hook) and refetch when it fires, since
a switch invalidates everything read from the previous chain.

Mainnet ships with no default RPC or factory contract. Set
`EXPO_PUBLIC_MAINNET_RPC_URL` and `EXPO_PUBLIC_FACTORY_CONTRACT_ID_MAINNET` to
use it; the settings screen says so plainly when they are missing.

## Structure

- `app/_layout.tsx` — root Stack navigator (expo-router).
- `app/index.tsx` — placeholder home route.

Native `ios/` and `android/` folders are generated on demand (via prebuild/EAS) and
are gitignored, along with `node_modules/` and `.expo/`.
