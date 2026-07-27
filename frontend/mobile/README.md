# Veil Mobile

Expo (expo-router + TypeScript) mobile app for Veil. The screens are still
placeholders — no wallet SDK is wired up yet — but the routes exist so deep
links have somewhere to land.

## Getting started

```bash
cd frontend/mobile
npm install
npx expo start
```

Then press `i` for the iOS simulator, `a` for the Android emulator, or `w` for web.

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run — unit tests
npm run e2e         # maestro — device tests on an emulator/simulator
npm run e2e:device  # maestro — real-device passkey smoke test
```

The Maestro suite and how to run it are documented in
[`.maestro/README.md`](.maestro/README.md).

## Structure

- `app/_layout.tsx` — root Stack navigator (expo-router).
- `app/index.tsx` — home route.
- `app/create-wallet.tsx`, `app/send.tsx`, `app/receive.tsx` — placeholder screens.
- `app/pay.tsx` — payment-request entry point; forwards into the send flow.
- `app/+native-intent.ts` — expo-router hook that normalises every inbound deep link.
- `lib/deepLinks.ts` — the pure resolver those two share.
- `app.config.ts` — Expo config, including the deep-linking surface.
- `.maestro/` — device e2e flows (create-wallet, send, receive, deep links, passkey).

Native `ios/` and `android/` folders are generated on demand (via prebuild/EAS) and
are gitignored, along with `node_modules/` and `.expo/`.

## Deep linking

Three URL families open the app, and all three resolve to the same in-app routes:

| Incoming URL | Resolves to |
| --- | --- |
| `veil://pay?to=G…&amount=10` | `/pay` → `/send`, prefilled |
| `https://app.veil.xyz/receive` | `/receive` |
| `web+stellar:pay?destination=G…&amount=10` | `/pay`, raw URI preserved as `uri` |
| anything else | `/` |

`app/+native-intent.ts` is called by expo-router for every inbound link, on a
cold start (`initial: true`) and on a warm resume (`initial: false`) alike, which
is what makes the two behave identically. It delegates to `resolveDeepLink()` in
`lib/deepLinks.ts`.

Inbound links are untrusted — any app, web page, or QR code can send one — so the
resolver matches a fixed allowlist of routes and copies only the query parameters
each route declares. Foreign hosts, unknown schemes, unknown paths, and
over-long URLs all fall back to `/` instead of navigating.

Full SEP-7 validation (address checksums, amount ranges, hostile callbacks) is
the job of the handler in backlog #38. `sdk/src/sep7.ts` already implements it
for the web wallet; the raw URI is forwarded to `/pay` as `uri` so that handler
can parse the original request unmodified.

### Testing links locally

The schemes are only registered in a dev-client or standalone build — deep links
do not reach the app through Expo Go.

```bash
# Android (emulator or device)
adb shell am start -W -a android.intent.action.VIEW \
  -d "veil://pay?to=GABC&amount=10" xyz.veil.wallet
adb shell am start -W -a android.intent.action.VIEW \
  -d "https://app.veil.xyz/receive" xyz.veil.wallet

# iOS simulator
xcrun simctl openurl booted "veil://pay?to=GABC&amount=10"
xcrun simctl openurl booted "https://app.veil.xyz/receive"
```

Run each command twice: once with the app force-quit (cold start) and once with
it backgrounded (warm resume). Both must land on the same screen.

### Universal / app link setup

Two verification files are served by the wallet web app from
`frontend/wallet/public/.well-known/`. Both currently carry placeholders that
must be replaced before a store build, or the platforms will silently keep
opening links in the browser:

- `apple-app-site-association` — replace `APPLE_TEAM_ID` with the Apple Developer
  Team ID that signs `xyz.veil.wallet`. The file must be served over HTTPS as
  `application/json`, with no redirect and no `.json` extension.
- `assetlinks.json` — replace `ANDROID_RELEASE_CERT_SHA256_FINGERPRINT` with the
  SHA-256 fingerprint of the release signing certificate
  (`keytool -list -v -keystore <keystore> -alias <alias>`). Add the Play App
  Signing fingerprint too if the app is distributed through Google Play.

`frontend/wallet/next.config.js` pins the `Content-Type` on both files. After
deploying, verify with Apple's CDN
(`https://app-site-association.cdn-apple.com/a/v1/app.veil.xyz`) and Google's
[Digital Asset Links API](https://developers.google.com/digital-asset-links/tools/generator).
