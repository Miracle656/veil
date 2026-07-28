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

## Structure

- `app/_layout.tsx` — root Stack navigator (expo-router).
- `app/index.tsx` — placeholder home route.
- `hooks/useTheme.ts`, `components/ThemeToggle.tsx`, `lib/theme.ts` — theming.

Native `ios/` and `android/` folders are generated on demand (via prebuild/EAS) and
are gitignored, along with `node_modules/` and `.expo/`.

## Multisig

`/multisig` connects to a deployed M-of-N wallet
(`contracts/multisig-wallet`) and runs the full lifecycle: an owner raises a
transfer, owners approve it, and the approval that reaches the threshold
executes it.

There is no Execute button, because the contract has no `execute` entry point —
`sign_transaction` performs the transfer in the same invocation that reaches the
threshold. The screen names that approval for what it is ("Approve and execute")
rather than implying a separate step that does not exist.

Deployment stays on the desktop wizard; the contract address is stored under the
same `veil_multisig_contract` key the web wallet uses. Point the screen at a
network with `EXPO_PUBLIC_SOROBAN_RPC_URL` and `EXPO_PUBLIC_NETWORK_PASSPHRASE`
(defaults to Soroban testnet).

`lib/multisig.ts` holds the rules the screen applies before touching the chain —
amount conversion, owner and duplicate-approval checks, and whether the next
approval is the deciding one — so a rejection arrives immediately instead of as
a contract panic after a fee.
