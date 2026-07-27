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

- `app/_layout.tsx` — root Stack navigator (expo-router); also listens for
  inbound `web+stellar:pay?...` / `veil://pay?...` deep links and routes to
  `/send` with the parsed fields pre-filled.
- `app/index.tsx` — placeholder home route.
- `app/send.tsx` — placeholder send screen showing whatever a SEP-7 pay link
  pre-filled (the interactive form lands in a follow-up issue).
- `lib/sep7.ts` — parses/builds SEP-7 `pay` URIs and the app's `veil://` link
  variant (ported from `frontend/wallet/lib/sep7.ts`).

Native `ios/` and `android/` folders are generated on demand (via prebuild/EAS) and
are gitignored, along with `node_modules/` and `.expo/`.
