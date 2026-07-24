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
- `app/index.tsx` — placeholder home route.

Native `ios/` and `android/` folders are generated on demand (via prebuild/EAS) and
are gitignored, along with `node_modules/` and `.expo/`.
