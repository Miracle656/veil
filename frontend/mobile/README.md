# Veil Mobile

Expo (expo-router + TypeScript) mobile app for Veil. It currently has the
dashboard shell — the top bar and "VEIL" wordmark — with data widgets (balance,
assets, activity, etc.) landing in follow-up issues. No wallet logic or SDK is
wired up yet.

## Getting started

```bash
cd frontend/mobile
npm install
npx expo start
```

Then press `i` for the iOS simulator, `a` for the Android emulator, or `w` for web.

## Structure

- `app/_layout.tsx` — root Stack navigator (expo-router).
- `app/(tabs)/index.tsx` — dashboard shell: top bar + "VEIL" wordmark.

Native `ios/` and `android/` folders are generated on demand (via prebuild/EAS) and
are gitignored, along with `node_modules/` and `.expo/`.
