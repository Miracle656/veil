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

## App lock

`/settings/security` controls the lock policy: how long the app may sit idle
before it locks (5 / 15 / 30 minutes, or never) and whether unlocking must
present a biometric factor. The timeout is stored under the same
`veil_idle_lock_minutes` key the web wallet uses, so the choice carries between
clients.

`lib/appLock.ts` holds both the policy and `createIdleWatcher`, the countdown the
lock screen (backlog #28) wires to. Changing the timeout applies immediately —
watchers subscribe to the settings store and reschedule, including shortening a
countdown that is already past its new deadline.

Two things differ from the web wallet's `lib/idle-lock.ts`. Activity is reported
explicitly through `noteActivity()`, since React Native has no global
mouse/keyboard stream. And backgrounding is not treated as activity: JS timers
do not run reliably while the app is away, so the watcher records when it left
the foreground and locks on return if the idle period already elapsed.

## Encrypted backups

`/settings/backup` exports the wallet's non-secret state — address, signer public
keys, settings — as an AES-256-GCM envelope sealed with a user passphrase, then
hands the file to the system share sheet.

The envelope format is byte-compatible with `sdk/src/backup.ts`, so a file
exported on mobile restores in the web wallet and vice versa. Private key
material never enters a backup: `assertNoSecretMaterial` in `lib/backup.ts`
rejects the metadata before encryption if it finds a secret-looking field.

## Structure

- `app/_layout.tsx` — root Stack navigator (expo-router).
- `app/index.tsx` — placeholder home route.
- `hooks/useTheme.ts`, `components/ThemeToggle.tsx`, `lib/theme.ts` — theming.

Native `ios/` and `android/` folders are generated on demand (via prebuild/EAS) and
are gitignored, along with `node_modules/` and `.expo/`.
