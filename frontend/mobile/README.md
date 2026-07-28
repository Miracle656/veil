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

The envelope format is byte-compatible with `sdk/src/backup.ts`, so a file
exported on mobile restores in the web wallet and vice versa. Private key
material never enters a backup: `assertNoSecretMaterial` in `lib/backup.ts`
rejects the metadata before encryption if it finds a secret-looking field.

## Agent chat

`/agent` is the mobile client for the Claude-powered assistant in
`packages/agent`. It speaks the same WebSocket protocol as the web wallet's
`/agent` page — `chat` and `clear_history` out, `thinking` / `response` /
`error` / `history_cleared` back — and shares its storage keys, so the profile
you set up in the browser carries over.

Point it at a server with `EXPO_PUBLIC_AGENT_WS_URL` (defaults to
`ws://localhost:3001`).

The transport lives in `lib/agentSocket.ts`, separated from the screen because a
phone's socket drops constantly — backgrounding the app is enough. It reconnects
with jittered exponential backoff, queues anything composed while offline and
flushes it on reconnect, and tracks in-flight requests: the agent server keeps no
outbox, so a reply interrupted by a drop is gone, and the screen says so instead
of spinning forever. Every external dependency (socket constructor, timers,
jitter) is injectable, which is how the reconnect paths are tested.

## Structure

- `app/_layout.tsx` — root Stack navigator (expo-router).
- `app/index.tsx` — placeholder home route.
- `hooks/useTheme.ts`, `components/ThemeToggle.tsx`, `lib/theme.ts` — theming.

Native `ios/` and `android/` folders are generated on demand (via prebuild/EAS) and
are gitignored, along with `node_modules/` and `.expo/`.
