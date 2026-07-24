# Veil Mobile App — Issue Backlog

Native mobile app (**Expo / React Native**) that **replicates the web wallet UI**
(`frontend/wallet`) and reuses `invisible-wallet-sdk`. Lives in `frontend/mobile`.

Each issue below is self-contained: **Goal**, **Create** (new files under
`frontend/mobile/…`), **Port/reference** (existing web files to translate),
**Deps** (packages to add), **Notes** (gotchas), **Acceptance** (checklist).

---

## Conventions (read first)

**Design tokens** — translate `frontend/wallet/app/globals.css` + `BRAND_GUIDELINES.md`
into `frontend/mobile/constants/theme.ts`. Never hardcode hex. Web classes to reproduce:
`.wallet-shell`, `.card`, `.card-md`, `.action-btn`, `.address-chip`, `.hl`.

**SDK import** — web uses the `@veil/sdk` / `@veil/utils` tsconfig aliases; **mobile
imports the package directly**: `import { useInvisibleWallet } from 'invisible-wallet-sdk'`.
Metro auto-swaps `sdk/src/webauthn.ts` → `sdk/src/webauthn.native.ts` via the package's
`"react-native"` field.

**Web → native package map** (use when porting):

| Web (`frontend/wallet`) | Native (`frontend/mobile`) |
|---|---|
| `next/navigation`, `next/link` | `expo-router` |
| `next/image` | `expo-image` |
| `framer-motion` | `react-native-reanimated` + `moti` |
| `lucide-react` | `lucide-react-native` |
| `qrcode.react` (`QRCodeCanvas`) | `react-native-qrcode-svg` |
| `jsqr` + `<video>` | `expo-camera` (barcode scanning) |
| `localStorage` / `sessionStorage` | `@react-native-async-storage/async-storage` |
| secrets (`sessionStorage` keypair) | `expo-secure-store` (Keychain/Keystore) |
| `window.crypto.getRandomValues` | `react-native-get-random-values` + `expo-crypto` |
| `@sentry/nextjs` | `@sentry/react-native` |
| `navigator.clipboard` | `expo-clipboard` |
| `@stellar/stellar-sdk` | same (needs polyfills — see #7) |

**`lib/` helpers to port** — most under `frontend/wallet/lib/` are framework-agnostic
Stellar logic and port almost verbatim (swap only storage/env): `deriveFeePayer`,
`fetchPrice`, `sep7`, `activityFeed`, `txState`, `schedules`, `sweepContractBalance`,
`trustlines`, `simulate`, `sorobanTx`, `soroswap`, `blend`, `vault`, `escrow`,
`feeBump`, `multisig`, `passkeyAuth`, `recovery`, `paymentRequest`, `sep24`,
`federation`, `walletConnect`, `supabase`, `idle-lock`. Each feature issue names the
exact ones it needs.

Labels: `mobile` on every issue + one `epic:*` (foundations, sdk, onboarding,
dashboard, send-receive, swap, defi, ramp, contacts, multisig, recovery, settings,
agent, dapp, release).

---

## Epic 0 — Scaffold & Foundations

### 1. Scaffold Expo app in `frontend/mobile` — `epic:foundations`
**Goal:** Stand up the mobile app package inside the existing monorepo so all later work
has a home next to `frontend/wallet`. This issue only creates the empty, bootable
expo-router + TypeScript shell — no wallet logic, no SDK, just a single placeholder route
proving the toolchain runs on both platforms.
**Create:** `frontend/mobile/` via `npx create-expo-app@latest frontend/mobile` (default template); trim demo screens down to a single placeholder `app/index.tsx`.
**Notes:** Do **not** wire the SDK yet. Add `frontend/mobile` to the repo's `.gitignore` patterns for `node_modules`, `.expo`, `ios/`, `android/`.
**Acceptance:** `npx expo start` boots on iOS simulator + Android emulator showing the placeholder home route.

### 2. Metro monorepo config — `epic:foundations`
**Goal:** Teach the Metro bundler to reach outside `frontend/mobile` and resolve the
local `invisible-wallet-sdk` from `sdk/`. Without this, imports of the workspace SDK fail
or pull the browser build; with it, Metro follows the package's `react-native` field and
bundles the native WebAuthn path automatically.
**Create:** `frontend/mobile/metro.config.js` — set `watchFolders` to include repo root + `sdk/`, `resolver.nodeModulesPaths` for hoisted deps, enable `unstable_enableSymlinks`.
**Port/reference:** SDK `package.json` `"react-native": "src/index.ts"` field.
**Acceptance:** `import { useInvisibleWallet } from 'invisible-wallet-sdk'` bundles, and a `console.log` confirms `webauthn.native.ts` is the resolved WebAuthn module (not `webauthn.ts`).

### 3. Brand theme constants — `epic:foundations`
**Goal:** Give every screen one canonical source of colors, spacing, and type so the app
matches the web wallet exactly. React Native has no CSS variables, so the `:root` tokens
and font roles from the web must be re-expressed as typed TS constants that components
import instead of hardcoding hex or font names.
**Create:** `frontend/mobile/constants/theme.ts` (colors, surfaces, spacing, radii), `frontend/mobile/constants/typography.ts` (font-family + size/weight per role).
**Port/reference:** `frontend/wallet/app/globals.css` (`:root` vars) + `BRAND_GUIDELINES.md` color/type tables.
**Acceptance:** exported `colors.gold === '#FDDA24'` etc.; no raw hex appears in any component PR after this.

### 4. Font loading via `expo-font` — `epic:foundations`
**Goal:** Load the four brand typefaces at startup and hold render until they are ready so
the UI never flashes a system font. Each font maps to a specific role (headings, accent
caps, body, monospace addresses) exactly as the web wallet uses them, keeping typographic
parity across platforms.
**Create:** font load in `frontend/mobile/app/_layout.tsx` using `useFonts`; add font files under `frontend/mobile/assets/fonts/`.
**Deps:** `expo-font`, `@expo-google-fonts/lora`, `@expo-google-fonts/anton`, `@expo-google-fonts/inter`, `@expo-google-fonts/inconsolata`.
**Notes:** roles — Lora 600 italic = headings, Anton = accent caps (letterSpacing 0.08em), Inter = body, Inconsolata = addresses/hashes.
**Acceptance:** a sample screen renders all four roles; no flash of system font.

### 5. Shared UI primitives — `epic:foundations`
**Goal:** Build the small set of reusable components that every screen composes from, so
feature issues don't each re-implement layout chrome. These are the native equivalents of
the web wallet's core CSS classes (shell, card, action button, address chip, gold
highlight), and getting them right once makes the rest of the port fast and consistent.
**Create:** `frontend/mobile/components/ui/Screen.tsx` (`.wallet-shell` shell + safe area), `Card.tsx` (`.card`/`.card-md`), `Button.tsx` (`.action-btn`, gold variants), `AddressChip.tsx` (`.address-chip`, monospace + copy), `Highlight.tsx` (`.hl` gold underlay).
**Port/reference:** `globals.css` lines for `.wallet-shell` (288), `.card` (178), `.action-btn` (142), `.address-chip` (210), `.hl` (76).
**Acceptance:** each primitive rendered in a demo screen matches the web look side-by-side.

### 6. Navigation shell — `epic:foundations`
**Goal:** Lay down the full route tree so every web page has a place to live before its
screen is built. This establishes the tab bar for primary destinations and stack routes
for the rest, letting later issues drop content into existing routes instead of also
having to wire navigation each time.
**Create:** `frontend/mobile/app/_layout.tsx` (root stack), `app/(tabs)/_layout.tsx` (tabs: dashboard/send/receive/settings), and route stubs for every web page (`swap`, `multisig`, `vault`, `earn`, `pools`, `buy`, `withdraw`, `contacts`, `recover`, `lock`, `agent`, `token/[id]`).
**Port/reference:** `frontend/wallet/app/*/page.tsx` route names.
**Acceptance:** every web route has a corresponding mobile route reachable via navigation.

### 7. RN polyfills — `epic:foundations`
**Goal:** Fill the gaps between the browser globals `@stellar/stellar-sdk` and WebAuthn
assume and what React Native actually ships. Without secure randomness, `Buffer`, text
encoders, and a `URL` implementation, key generation and transaction building crash at
runtime, so this must land before any SDK or signing work.
**Create:** `frontend/mobile/polyfills.ts` importing `react-native-get-random-values`, `Buffer` (global), `TextEncoder`/`TextDecoder`, `URL`/`URLSearchParams`; import it first line of `app/_layout.tsx`.
**Deps:** `react-native-get-random-values`, `buffer`, `text-encoding`, `react-native-url-polyfill`, `expo-crypto`.
**Acceptance:** `new TransactionBuilder(...)` and `Keypair.random()` work; `atob`/`btoa` used by `webauthn.native.ts` resolve.

### 8. Port `lib/network.ts` — `epic:foundations`
**Goal:** Recreate the wallet's network configuration layer so the app knows which RPC,
Horizon, factory contract, and passphrase to use per environment. The logic is identical
to web, but env values must come from Expo's config channel rather than Next's
`process.env.NEXT_PUBLIC_*`, which does not exist on device.
**Create:** `frontend/mobile/lib/network.ts` — same `NETWORKS`/`getNetwork()`/`walletConfig`/`getNativeAssetContractId()`/`buildFriendbotUrl()` API, but read env via `expo-constants` (`Constants.expoConfig.extra`) instead of `process.env.NEXT_PUBLIC_*`.
**Port/reference:** `frontend/wallet/lib/network.ts` (verbatim logic).
**Create:** `frontend/mobile/app.config.ts` mapping EAS/`.env` vars into `extra`.
**Acceptance:** `getNetwork().name === 'testnet'` by default; factory id/RPC resolved from env.

### 9. tsconfig + path aliases — `epic:foundations`
**Goal:** Configure TypeScript in strict mode with the `@/` import alias so mobile code
reads the same way as the web wallet and catches type errors early. This keeps imports
short and lets contributors move between the two apps without relearning conventions.
**Create:** `frontend/mobile/tsconfig.json` extending `expo/tsconfig.base`, `paths: { "@/*": ["./*"] }`.
**Acceptance:** `tsc --noEmit` passes on the scaffold.

### 10. ESLint / Prettier — `epic:foundations`
**Goal:** Match the repo's linting and formatting rules inside the mobile package so every
contribution is held to the same bar and diffs stay clean. Aligning tooling now prevents
noisy style-only churn once many people are opening feature PRs.
**Create:** `frontend/mobile/.eslintrc.js` (`eslint-config-expo`) + Prettier config aligned to root.
**Acceptance:** `expo lint` passes clean.

### 11. CI workflow for mobile — `epic:release`
**Goal:** Make continuous integration exercise the mobile package so regressions are
caught in PRs rather than after merge. A dedicated job (or extension of the existing
pipeline) should install, typecheck, and lint whenever files under `frontend/mobile`
change, without slowing unrelated builds.
**Modify:** `.github/workflows/` — add a `mobile` job (or new workflow) running install + `tsc --noEmit` + `expo lint` scoped to `frontend/mobile/**`.
**Port/reference:** existing `ci.yml`.
**Acceptance:** CI runs on PRs that change `frontend/mobile/`.

### 12. App icon + splash — `epic:foundations`
**Goal:** Produce the branded launch assets so the installed app looks finished from first
tap. The icon and splash should use the near-black background and gold "VEIL" wordmark
from the brand guidelines, wired through Expo's asset config for all densities.
**Create:** `frontend/mobile/assets/icon.png`, `adaptive-icon.png`, `splash.png`; wire in `app.config.ts` (`expo-splash-screen`).
**Notes:** near-black bg, gold "VEIL".
**Acceptance:** icon + splash show on device install.

### 13. Safe-area + dark status bar — `epic:foundations`
**Goal:** Ensure content respects notches, rounded corners, and home indicators on every
device, and that the status bar chrome stays legible against the dark theme. Setting this
globally once avoids per-screen padding hacks and keeps the app looking native.
**Create/Modify:** wrap root in `SafeAreaProvider`; set `StatusBar` style light, near-black bg app-wide.
**Deps:** `react-native-safe-area-context`, `expo-status-bar`.
**Acceptance:** no content under notch; status bar icons light on all screens.

### 14. Global error boundary + Sentry — `epic:release`
**Goal:** Catch unhandled render errors so a single failure shows a recoverable fallback
instead of a white screen, and report crashes to Sentry for triage. This mirrors the web
wallet's monitoring so production issues on mobile are just as visible.
**Create:** `frontend/mobile/components/ErrorBoundary.tsx`; Sentry init in `app/_layout.tsx`.
**Port/reference:** `frontend/wallet/app/SentryInit.tsx`, `frontend/wallet/lib/sentry.ts`.
**Deps:** `@sentry/react-native`.
**Acceptance:** a thrown error shows fallback UI; event reaches Sentry when DSN set.

---

## Epic 1 — SDK Integration & Passkeys

### 15. Wire SDK + port `WalletProvider` — `epic:sdk`
**Goal:** Establish the app-wide wallet context that every screen reads from, wrapping
`useInvisibleWallet(walletConfig)` and exposing the current session. Unlike web, which
keeps the signer in memory, native must persist the session securely so it survives the
app being backgrounded or killed by the OS.
**Create:** `frontend/mobile/components/WalletProvider.tsx` exposing `session`, `setSession`, `wallet`, `clearSession`; mount in `app/_layout.tsx`. Persist session via `expo-secure-store` (web keeps `signerKeypair` in memory — native must survive backgrounding).
**Port/reference:** `frontend/wallet/components/WalletProvider.tsx`, `frontend/mobile/lib/network.ts` (`walletConfig`).
**Acceptance:** `useWallet()` returns a live `useInvisibleWallet(walletConfig)` from any screen.

### 16. `react-native-passkey` + dev-client — `epic:sdk`
**Goal:** Bring the native passkey module into the build, which is the whole premise of
the wallet. Because it contains native code, Expo Go cannot load it, so this issue also
sets up prebuild and a custom dev client that all subsequent passkey testing depends on.
**Modify:** add `react-native-passkey` dep; `npx expo prebuild`; build a dev client (local or EAS).
**Deps:** `react-native-passkey`.
**Notes:** `sdk/src/webauthn.native.ts` already imports `{ Passkey } from 'react-native-passkey'`.
**Acceptance:** `Passkey.isSupported()` returns true on a real iOS 16+/Android 13+ device via dev client.

### 17. Explicit `rpId` config — `epic:sdk`
**Goal:** Supply the Relying Party ID explicitly because native has no
`window.location.hostname` for the SDK to infer from. If left unset the SDK falls back to
`localhost`, which breaks passkey binding on device, so the production domain must be
threaded through `walletConfig`.
**Modify:** `frontend/mobile/lib/network.ts` `walletConfig` → add `rpId` + `origin` from env.
**Port/reference:** `sdk/src/useInvisibleWallet.ts:596` (`resolvedRpId` fallback to `'localhost'`).
**Acceptance:** register/authenticate calls send the intended production `rpId`, not `localhost`.

### 18. iOS Associated Domains — `epic:sdk`
**Goal:** Set up the Apple side of passkey domain binding so credentials created in the
app are trusted for the same Relying Party as the web wallet. This requires hosting the
association file on the domain and declaring the entitlement, enabling one shared passkey
across web and iOS.
**Create:** host `apple-app-site-association` (`webcredentials` block with Team ID + bundle id) on the wallet domain; add `associatedDomains: ["webcredentials:<domain>"]` to `app.config.ts`.
**Notes:** requires paid Apple Developer account; use the **same** RP ID as the web wallet so passkeys are shared.
**Acceptance:** passkey created on device is offered on the web wallet for the same RP ID (and vice-versa).

### 19. Android asset links — `epic:sdk`
**Goal:** Set up the Android equivalent of passkey domain binding via Digital Asset Links,
proving the app and website belong to the same entity. This is self-serve and needs no
paid account, so it should land first and unblock real-device passkey testing on Android.
**Create:** host `/.well-known/assetlinks.json` on the domain with the app's signing-cert SHA-256; add intent filter / autoVerify in `app.config.ts`.
**Notes:** self-serve (no paid account) — do this before iOS.
**Acceptance:** Digital Asset Links validator passes; passkey shared with web RP ID.

### 20. Verify fee-payer HKDF on native — `epic:sdk`
**Goal:** Confirm the deterministic fee-payer (sponsor) keypair the SDK derives from the
passkey is byte-identical on native and web. Because the wallet is fee-sponsored, a
mismatch would send fees from the wrong account, so this is a correctness check on the
HKDF derivation path under the native crypto polyfills.
**Create:** `frontend/mobile/lib/deriveFeePayer.ts`.
**Port/reference:** `frontend/wallet/lib/deriveFeePayer.ts` (`deriveStoredFeePayer`).
**Acceptance:** same passkey → identical `G…` fee-payer address on web and native.

### 21. Counterfactual address preview — `epic:sdk`
**Goal:** Show the user their wallet's contract address before the deploy transaction is
even submitted, using the SDK's counterfactual computation. This lets onboarding display a
real, fundable address immediately and confirms the predicted address matches what is
later deployed.
**Port/reference:** `sdk/src/counterfactual.ts` exports.
**Acceptance:** onboarding shows the predicted `C…` address pre-deploy; it matches the deployed address.

### 22. Offline tx queue (outbox) — `epic:sdk`
**Goal:** Make transactions queued while offline durable so they aren't lost when the app
restarts. The SDK's outbox needs a native persistent backend (AsyncStorage or SQLite) so
pending payments replay automatically once connectivity returns.
**Create:** `frontend/mobile/lib/outbox.ts` backing `sdk/src/outbox.ts` with AsyncStorage/SQLite.
**Port/reference:** `sdk/src/outbox.ts`.
**Deps:** `@react-native-async-storage/async-storage` (or `expo-sqlite`).
**Acceptance:** a tx queued offline replays after relaunch + reconnect.

### 23. Secure metadata storage — `epic:sdk`
**Goal:** Persist wallet metadata (credential id, contract address) in the platform secure
enclave rather than plain storage, and provide a single helper the rest of the app uses.
Every ported web call to `localStorage`/`sessionStorage` for sensitive data must route
through this so secrets never land in unencrypted storage.
**Create:** `frontend/mobile/lib/storage.ts` wrapping `expo-secure-store` (Keychain/Keystore) with a JSON helper; replace all web `localStorage`/`sessionStorage` calls in ported code.
**Deps:** `expo-secure-store`.
**Acceptance:** wallet metadata survives relaunch; secrets never hit AsyncStorage/plain storage.

---

## Epic 2 — Onboarding

### 24. Welcome / intro screens — `epic:onboarding`
**Goal:** Greet first-time users with the brand's introductory story before asking them to
create anything. This is the mobile translation of the web landing experience, setting the
tone and explaining that a passkey is the wallet, then routing returning users straight
past it.
**Create:** `frontend/mobile/app/(onboarding)/welcome.tsx`.
**Port/reference:** `frontend/wallet/app/page.tsx` (intro/hero region, 224 lines).
**Acceptance:** first launch shows intro; returning users skip to dashboard.

### 25. Create wallet — passkey register → factory deploy — `epic:onboarding`
**Goal:** Implement the core account-creation flow that turns a device biometric into a
usable smart wallet. It runs WebAuthn credential creation, extracts the P-256 public key,
and deploys the wallet contract through the factory, ending with an active session on the
dashboard.
**Create:** `frontend/mobile/app/(onboarding)/create.tsx`.
**Port/reference:** web create path in `app/page.tsx`; SDK `useInvisibleWallet` `register()`.
**Acceptance:** WebAuthn credential created → wallet contract deployed → session set → lands on dashboard.

### 26. Restore / import existing wallet — `epic:onboarding`
**Goal:** Let a returning user regain access on a new install by authenticating with an
existing passkey and re-deriving their wallet contract address. This is the counterpart to
create and is essential so users aren't locked out after reinstalling or switching
devices.
**Create:** `frontend/mobile/app/(onboarding)/restore.tsx`.
**Port/reference:** SDK authenticate path; `frontend/wallet/lib/passkeyAuth.ts`.
**Acceptance:** existing passkey → recovers contract address → session set.

### 27. First-run tutorial — `epic:onboarding`
**Goal:** Provide the dismissible coach-marks that orient new users on their first session,
mirroring the web tutorial. It must remember dismissal and expose a skip flag so automated
e2e flows can bypass it, matching the recent web change that unblocks the create-wallet
test.
**Create:** `frontend/mobile/components/OnboardingTutorial.tsx`.
**Port/reference:** `frontend/wallet/components/OnboardingTutorial.tsx`.
**Notes:** e2e must be able to skip it (see web `test(e2e): skip first-run tutorial`).
**Acceptance:** tutorial shows once, dismiss persists, skip flag available for tests.

### 28. App-lock / lock screen — `epic:onboarding`
**Goal:** Protect the wallet when the device is idle or the app is backgrounded by
requiring a biometric to return. This ports the inactivity-lock behavior to native
`AppState` and `expo-local-authentication`, so a lost or borrowed phone doesn't expose
funds.
**Create:** `frontend/mobile/app/lock.tsx`, `frontend/mobile/hooks/useInactivityLock.ts`.
**Port/reference:** `frontend/wallet/app/lock/page.tsx`, `hooks/useInactivityLock.ts`, `lib/idle-lock.ts`.
**Deps:** `expo-local-authentication`, `AppState`.
**Acceptance:** app locks after timeout/background; Face ID/fingerprint unlocks.

---

## Epic 3 — Dashboard

### 29. Dashboard layout + header — `epic:dashboard`
**Goal:** Build the home screen frame that everything else on the dashboard sits inside —
the shell, the "VEIL" wordmark, and the top bar. The web dashboard is over a thousand
lines, so this issue owns only the structural chrome and leaves data widgets to #30–#34.
**Create:** `frontend/mobile/app/(tabs)/index.tsx`.
**Port/reference:** `frontend/wallet/app/dashboard/page.tsx` header region (1129 lines total — split across #29–#34), `components/VeilLogo.tsx`.
**Acceptance:** dashboard shell + "VEIL" wordmark render.

### 30. Balance card — `epic:dashboard`
**Goal:** Show the user their primary balance the moment they open the app — native XLM
plus its fiat value fetched from the Lens price oracle. This is the most-looked-at element
in the product, so it must load quickly and degrade gracefully when the price feed is
unavailable.
**Create:** `frontend/mobile/components/BalanceCard.tsx`, `frontend/mobile/lib/fetchPrice.ts`.
**Port/reference:** `frontend/wallet/lib/fetchPrice.ts` (`fetchPrices`, Lens `NEXT_PUBLIC_LENS_URL`), balance query in `dashboard/page.tsx`.
**Acceptance:** shows XLM balance + USD via Lens; handles price-fetch failure.

### 31. Asset list — `epic:dashboard`
**Goal:** Display every asset the wallet holds beyond XLM, reading trustlines and balances
so users see their full portfolio. This ports the web assets view into a scrollable native
list with code, issuer, and balance per row.
**Create:** `frontend/mobile/app/assets.tsx` + `components/AssetRow.tsx`.
**Port/reference:** `frontend/wallet/app/assets/page.tsx` (365 lines), `lib/trustlines.ts`.
**Acceptance:** all held assets listed with code/issuer/balance.

### 32. Quick-actions row — `epic:dashboard`
**Goal:** Give users one-tap access to the most common tasks — send, receive, swap, buy —
right on the dashboard. This reproduces the web `.action-btn` grid as native buttons that
navigate to the correct routes, making the primary flows reachable without menu-diving.
**Create:** `frontend/mobile/components/QuickActions.tsx`.
**Port/reference:** `.action-btn` grid in `dashboard/page.tsx` + `globals.css:142`.
**Acceptance:** four actions navigate to correct routes.

### 33. Recent activity feed — `epic:dashboard`
**Goal:** Surface the wallet's recent transfers so users can confirm money moved without
leaving the dashboard. It pulls history from the Wraith indexer and appends new
transactions live, porting the web activity-feed store and its hydrate/append lifecycle.
**Create:** `frontend/mobile/lib/activityFeed.ts`, `components/ActivityFeed.tsx`.
**Port/reference:** `frontend/wallet/lib/activityFeed.ts` (`useActivityFeed`, `hydrateActivityFeed`, `appendActivityFeed`); Wraith `GET /transfers/:address`.
**Acceptance:** recent transfers render; new tx appends live.

### 34. Pull-to-refresh + polling — `epic:dashboard`
**Goal:** Keep the dashboard fresh through both an explicit pull gesture and quiet
background polling of balance and activity. Users expect a native refresh affordance, and
polling ensures the view reflects on-chain state shortly after any change.
**Modify:** dashboard uses `RefreshControl` + interval polling for balance/activity.
**Port/reference:** polling logic in `dashboard/page.tsx`.
**Acceptance:** pull refreshes balance + feed; auto-updates on interval.

### 35. Token detail screen — `epic:dashboard`
**Goal:** Let users drill into a single asset to see its balance, current price, and its
own transaction history. This is the destination when tapping a row in the asset list,
giving a focused per-token view that mirrors the web token route.
**Create:** `frontend/mobile/app/token/[id].tsx`.
**Port/reference:** `frontend/wallet/app/token/` route intent (balance, price, per-asset history).
**Acceptance:** tapping an asset opens its detail (balance, price, transfers).

---

## Epic 4 — Send / Receive

### 36. Send screen — recipient + amount — `epic:send-receive`
**Goal:** Build the entry point of the payment flow — the form where users choose a
recipient, asset, amount, and memo, then move to a confirmation step. This ports the web
send page's multi-step state machine and input validation, laying the UI groundwork that
signing (#37) plugs into.
**Create:** `frontend/mobile/app/(tabs)/send.tsx`.
**Port/reference:** `frontend/wallet/app/send/page.tsx` (571 lines; `Step = 'form'|'confirm'|'signing'|'done'|'error'`), `lib/txState.ts` (`beginTx`/`endTx`).
**Acceptance:** recipient/asset/amount/memo inputs with validation and a confirm step.

### 37. Send — passkey sign + submit — `epic:send-receive`
**Goal:** Complete the payment by building the Soroban transfer, having the user authorize
it with their passkey, submitting it, and polling for the result. This is where the
wallet's core value shows up on mobile: moving funds signed only by a device biometric.
**Modify:** `send.tsx` — build tx (native SAC transfer), `signAuthEntry` via passkey, submit, poll result.
**Port/reference:** signing path in `send/page.tsx`; `lib/sorobanTx.ts`, `lib/simulate.ts`, `lib/feeBump.ts`.
**Acceptance:** payment confirmed on testnet; success shows tx hash; failure shows error state.

### 38. SEP-7 pay URI + deep link — `epic:send-receive`
**Goal:** Let payment requests flow into the app from links and QR codes by parsing the
SEP-7 standard and handling `web+stellar:` / `veil://` deep links. Tapping such a link
should open the send flow with the amount and recipient already filled in.
**Create:** `frontend/mobile/lib/sep7.ts`; deep-link handler in `app/_layout.tsx`.
**Port/reference:** `frontend/wallet/lib/sep7.ts` (`parseQrValue`, `buildSep7PayUri`) + SDK `sdk/src/sep7.ts`.
**Acceptance:** a `web+stellar:pay?...` / `veil://` link prefills the send form.

### 39. Address validation + contact picker — `epic:send-receive`
**Goal:** Stop bad payments before they happen by validating destinations (including
federated addresses) and let users pick a saved contact instead of typing. This wires the
SDK's validation and the contact picker into the send form for safer, faster entry.
**Modify:** `send.tsx` uses `isValidDestination` (SDK) + `ContactPicker` (#54).
**Port/reference:** `sdk/src/sep7.ts` `isValidDestination`; `lib/federation.ts` for federated addresses.
**Acceptance:** invalid address blocks submit; contact selection fills recipient.

### 40. QR scanner — `epic:send-receive`
**Goal:** Let users pay by pointing their camera at a Stellar or SEP-7 QR code instead of
copying addresses. This replaces the web scanner's `jsqr`/`<video>` approach with
`expo-camera`, including permission handling, and feeds the decoded value into the send
form.
**Create:** `frontend/mobile/components/QrScanner.tsx`.
**Port/reference:** `frontend/wallet/components/QrScanner.tsx` (replace `jsqr`/`<video>`).
**Deps:** `expo-camera`.
**Acceptance:** scanning a Stellar/SEP-7 QR fills the recipient field; camera permission handled.

### 41. Receive screen + QR generate — `epic:send-receive`
**Goal:** Give users an easy way to get paid by showing their address as copyable text and
a scannable QR, with the option to share it. This ports the web receive page's address
card and SEP-7 URI generation to native QR and share sheets.
**Create:** `frontend/mobile/app/(tabs)/receive.tsx`.
**Port/reference:** `frontend/wallet/app/receive/page.tsx` (284 lines, `AddressCard`), `buildSep7PayUri`.
**Deps:** `react-native-qrcode-svg`, `expo-clipboard`, `expo-sharing`.
**Acceptance:** address + QR render; copy + share work.

### 42. Tx preview + detail sheets — `epic:send-receive`
**Goal:** Provide the reusable transaction surfaces used across the app — a preview card
shown before signing and a detail sheet opened from history. Porting these as native
bottom sheets keeps transaction presentation consistent everywhere it appears.
**Create:** `frontend/mobile/components/TxPreviewCard.tsx`, `components/TxDetailSheet.tsx` (bottom sheet).
**Port/reference:** `frontend/wallet/components/TxPreviewCard.tsx`, `TxDetailSheet.tsx` (`TxRecord` type).
**Deps:** `@gorhom/bottom-sheet`.
**Acceptance:** confirm step shows preview; tapping a feed item opens the detail sheet.

### 43. Bulk payout screen — `epic:send-receive`
**Goal:** Support paying many recipients in a single authorized submission, useful for
payroll or airdrops. This ports the SDK's bulk-payout logic into a native screen where
users assemble a list and sign once for the whole batch.
**Create:** `frontend/mobile/app/bulk-payout.tsx`.
**Port/reference:** `sdk/src/bulkPayout.ts`, `frontend/wallet/lib/bulkPayout.ts`.
**Acceptance:** add N recipients, sign once, all payments submitted.

---

## Epic 5 — Swap

### 44. Swap UI — `epic:swap`
**Goal:** Build the interface for exchanging one asset for another — the in/out token
selectors and amount inputs that anchor the swap experience. This ports the layout of the
large web swap page and prepares the surface that quoting (#45) and execution (#46) fill
in.
**Create:** `frontend/mobile/app/swap.tsx`.
**Port/reference:** `frontend/wallet/app/swap/page.tsx` (832 lines).
**Acceptance:** select in/out assets, enter amount, see empty-quote state.

### 45. Swap quote via Soroswap — `epic:swap`
**Goal:** Fetch live pricing for a prospective swap so users see the rate, expected output,
and price impact before committing. This ports the Soroswap integration and drives the
quote as the user changes the input amount or selected assets.
**Create:** `frontend/mobile/lib/soroswap.ts`.
**Port/reference:** `frontend/wallet/lib/soroswap.ts` (`@soroswap/sdk`).
**Acceptance:** entering an amount shows a live quote/rate + price impact.

### 46. Swap execute + sign — `epic:swap`
**Goal:** Finish the swap by building the transaction, authorizing it with the passkey, and
submitting it, then reflecting the result. Completing this makes the wallet a place to
trade, not just hold, and closes the swap flow end to end.
**Modify:** `swap.tsx` — passkey sign + submit swap tx, result states.
**Port/reference:** execute path in `swap/page.tsx`, `lib/sorobanTx.ts`.
**Acceptance:** swap confirmed on testnet; balances update.

---

## Epic 6 — DeFi

### 47. Earn screen — `epic:defi`
**Goal:** Let users put idle assets to work by supplying to Blend lending pools and earning
yield from within the wallet. This ports the earn page and its Blend SDK integration,
showing positions and APYs and letting users supply or withdraw with passkey-signed
transactions.
**Create:** `frontend/mobile/app/earn.tsx`, `lib/blend.ts`.
**Port/reference:** `frontend/wallet/app/earn/page.tsx` (506 lines), `lib/blend.ts` (`@blend-capital/blend-sdk`).
**Acceptance:** earn positions/APYs render; supply/withdraw actions sign + submit.

### 48. Pools screen — `epic:defi`
**Goal:** Give users access to liquidity pools so they can provide liquidity and manage
positions. This ports the sizeable web pools page, listing available pools and supporting
add/remove-liquidity flows on native.
**Create:** `frontend/mobile/app/pools.tsx`.
**Port/reference:** `frontend/wallet/app/pools/page.tsx` (787 lines).
**Acceptance:** pools listed; add/remove liquidity flows work.

### 49. Vault screen — `epic:defi`
**Goal:** Support depositing into and withdrawing from vaults, including any escrow
mechanics the web wallet exposes. This ports the vault page and its supporting logic so
users can manage vault balances entirely from mobile.
**Create:** `frontend/mobile/app/vault.tsx`, `lib/vault.ts`, `lib/escrow.ts`.
**Port/reference:** `frontend/wallet/app/vault/page.tsx` (706 lines), `lib/vault.ts`, `lib/escrow.ts`.
**Acceptance:** vault balances render; deposit/withdraw sign + submit.

---

## Epic 7 — On / Off Ramp

### 50. Buy screen — `epic:ramp`
**Goal:** Let users bring fiat into the wallet through a SEP-24 anchor, launching the
anchor's interactive flow and returning cleanly to the app. This is the on-ramp that turns
the wallet from a place to hold crypto into a place to acquire it.
**Create:** `frontend/mobile/app/buy.tsx`, `lib/sep24.ts`.
**Port/reference:** `frontend/wallet/app/buy/page.tsx` (439 lines), `lib/sep24.ts`.
**Notes:** interactive SEP-24 flow opens a webview — use `expo-web-browser`.
**Acceptance:** buy flow launches the anchor interactive URL and returns to app.

### 51. Withdraw screen — `epic:ramp`
**Goal:** Provide the off-ramp so users can cash out to fiat through a SEP-24 anchor,
completing the interactive withdrawal step and sweeping contract balances as needed. This
closes the money-in/money-out loop alongside the buy flow.
**Create:** `frontend/mobile/app/withdraw.tsx`.
**Port/reference:** `frontend/wallet/app/withdraw/page.tsx` (633 lines), `lib/sep24.ts`, `lib/sweepContractBalance.ts`.
**Acceptance:** withdraw flow completes anchor interactive step.

---

## Epic 8 — Contacts

### 52. Contacts list — `epic:contacts`
**Goal:** Let users keep an address book of people they pay so they don't re-enter long
Stellar addresses. This ports the contacts store to AsyncStorage-backed persistence and
renders the saved list, forming the base the add/edit and picker issues build on.
**Create:** `frontend/mobile/app/contacts.tsx`, `hooks/useContacts.ts` (AsyncStorage-backed).
**Port/reference:** `frontend/wallet/app/contacts/page.tsx` (139 lines), `components/useContacts.ts`.
**Acceptance:** contacts persist + list.

### 53. Add / edit contact — `epic:contacts`
**Goal:** Give users full control over their address book with create, edit, and delete,
including validation of the stored address. Persisting these changes across relaunch makes
the contacts feature genuinely useful rather than session-only.
**Modify:** `contacts.tsx` — add/edit/delete with validation.
**Acceptance:** create/update/delete persist across relaunch.

### 54. `ContactPicker` component — `epic:contacts`
**Goal:** Provide a reusable picker that returns a chosen contact's address to whatever
flow opened it, so send and bulk-payout can offer contact selection. Centralizing it here
avoids duplicating selection UI across every screen that needs a recipient.
**Create:** `frontend/mobile/components/ContactPicker.tsx`.
**Port/reference:** `frontend/wallet/components/ContactPicker.tsx`.
**Acceptance:** picker returns a selected address to caller (used by #39, #43).

---

## Epic 9 — Multisig

### 55. Multisig screen — `epic:multisig`
**Goal:** Show the wallet's multi-signature configuration — the current signer set and
threshold — so users understand who can authorize transactions. This ports the multisig
overview page and reads the on-chain signer state into a native view.
**Create:** `frontend/mobile/app/multisig.tsx`, `lib/multisig.ts`.
**Port/reference:** `frontend/wallet/app/multisig/page.tsx` (86 lines), `lib/multisig.ts`.
**Acceptance:** current signers + threshold render.

### 56. Multisig approval flow — `epic:multisig`
**Goal:** Enable the full lifecycle of a multi-signer transaction: propose it, collect the
required approvals, and execute once the threshold is met. This turns the read-only
multisig view into a working coordination tool for shared wallets.
**Modify:** `multisig.tsx` — multi-signer proposal + approval + execute.
**Acceptance:** a proposal can be approved by required signers and executed.

---

## Epic 10 — Recovery & Backup

### 57. Recover screen (SEP-30) — `epic:recovery`
**Goal:** Give users a way back into their wallet if they lose their device, using SEP-30
recovery servers to bind a fresh signer to the existing account. This ports the recovery
page and its server integration, a critical safety net for a passkey-only wallet.
**Create:** `frontend/mobile/app/recover.tsx`, `lib/recovery.ts`.
**Port/reference:** `frontend/wallet/app/recover/page.tsx` (394 lines), `lib/recovery.ts`, `sdk/src/recovery/sep30`.
**Acceptance:** recovery flow re-binds a new signer to the wallet.

### 58. Backup create / export — `epic:recovery`
**Goal:** Let users export an encrypted backup of their wallet so they hold their own
recovery material. This uses the SDK's backup routines to produce a shareable encrypted
file while guaranteeing, via `assertNoSecretMaterial`, that nothing sensitive leaks in
plaintext.
**Create:** `frontend/mobile/app/settings/backup.tsx`.
**Port/reference:** `sdk/src/backup.ts` (`encryptBackup`, `createBackup`, `serializeBackup`), `frontend/wallet/lib/backup.ts`.
**Deps:** `expo-file-system`, `expo-sharing`.
**Acceptance:** produces an encrypted backup file the user can save/share; `assertNoSecretMaterial` passes.

### 59. Backup restore — `epic:recovery`
**Goal:** Complete the backup story by importing a previously exported file, decrypting it,
and binding a new signer to restore access. It must reject tampered files loudly with
`BackupTamperError` so users are never silently given a corrupted restore.
**Modify:** backup screen — `decryptBackup`/`restoreBackup`/`bindNewSigner`.
**Port/reference:** `sdk/src/backup.ts`.
**Deps:** `expo-document-picker`.
**Acceptance:** importing a backup restores wallet access; tampered backup throws `BackupTamperError`.

---

## Epic 11 — Settings

### 60. Settings shell — `epic:settings`
**Goal:** Create the settings screen structure that groups all configuration into
navigable sections. The web settings page is large, so this issue establishes the layout
and sections that the following settings issues fill with real controls.
**Create:** `frontend/mobile/app/(tabs)/settings.tsx`.
**Port/reference:** `frontend/wallet/app/settings/page.tsx` (854 lines).
**Acceptance:** grouped settings sections render + navigate.

### 61. Network switch — `epic:settings`
**Goal:** Allow users (and testers) to switch between testnet and mainnet at runtime rather
than only at build time. This persists an override that `lib/network.ts` reads, re-points
the RPC and factory contract, and reloads wallet state for the chosen network.
**Modify:** settings + `lib/network.ts` to read a persisted override (AsyncStorage) instead of build-time env only.
**Acceptance:** switching network re-points RPC/factory and reloads wallet state.

### 62. Theme toggle — `epic:settings`
**Goal:** Offer a light/dark theme switch if light mode is in scope, persisting the user's
choice and restyling the app accordingly. This ports the web theme hook and toggle so
appearance preferences carry over to mobile.
**Create:** `frontend/mobile/hooks/useTheme.ts`, `components/ThemeToggle.tsx`.
**Port/reference:** `frontend/wallet/hooks/useTheme.ts`, `components/ThemeToggle.tsx`.
**Acceptance:** toggle persists + restyles the app.

### 63. Security settings — `epic:settings`
**Goal:** Let users tune the app-lock behavior — the inactivity timeout and whether
biometric unlock is required — feeding the lock system from #28. Giving users this control
balances convenience against the security of their funds.
**Modify:** settings — lock timeout + biometric toggle feeding #28.
**Acceptance:** changing timeout changes lock behavior.

### 64. About / version / links — `epic:settings`
**Goal:** Show the housekeeping details users occasionally need — app version, active
network, contract addresses, and links to external resources. This provides transparency
and a support surface, opening links in the system browser.
**Modify:** settings — app version (`expo-constants`), network, contract addresses, external links (`expo-web-browser`).
**Acceptance:** shows correct version + tappable links.

---

## Epic 12 — AI Agent

### 65. Agent chat screen — `epic:agent`
**Goal:** Bring the Claude-powered assistant to mobile with a chat screen that connects to
the `packages/agent` service over WebSocket. It must handle sending and receiving messages
and recover from dropped connections, porting the substantial web agent page.
**Create:** `frontend/mobile/app/agent.tsx`, `lib/agentSocket.ts`.
**Port/reference:** `frontend/wallet/app/agent/page.tsx` (741 lines); `packages/agent` server + WS protocol.
**Acceptance:** connects, sends/receives messages, handles reconnect.

### 66. Agent message rendering + tx actions — `epic:agent`
**Goal:** Render the agent's different message types and let it propose wallet actions,
while keeping the user firmly in control. Any agent-suggested transaction must require an
explicit passkey confirmation before it can execute, so the assistant can never move funds
on its own.
**Modify:** `agent.tsx` — render message types; agent-proposed tx requires an explicit passkey confirm before signing.
**Acceptance:** an agent-proposed payment prompts the user and only executes after passkey confirm.

---

## Epic 13 — dApp Connect

### 67. WalletConnect / connect modal — `epic:dapp`
**Goal:** Let the wallet pair with external dApps via WalletConnect so users can sign for
web apps from their phone. This ports the connect modal and WalletConnect integration,
including the RN compatibility shims the library needs, and establishes sessions from a
scanned or pasted URI.
**Create:** `frontend/mobile/components/ConnectDAppModal.tsx`, `lib/walletConnect.ts`, `hooks/useWalletConnect.ts`.
**Port/reference:** `frontend/wallet/components/ConnectDAppModal.tsx`, `lib/walletConnect.ts`, `hooks/useWalletConnect.ts` (`@walletconnect/web3wallet`).
**Notes:** WalletConnect on RN needs `@walletconnect/react-native-compat` + polyfills.
**Acceptance:** scanning/pasting a WC URI establishes a session.

### 68. dApp approval modal — `epic:dapp`
**Goal:** Present incoming dApp session and signing requests for explicit user approval or
rejection, signing approved requests with the passkey. This is the safety gate on
WalletConnect, ensuring the user consciously authorizes anything a connected dApp asks
for.
**Create:** `frontend/mobile/components/WalletConnectApprovalModal.tsx`.
**Port/reference:** `frontend/wallet/components/WalletConnectApprovalModal.tsx`.
**Acceptance:** incoming session/sign request shows approve/reject; approval signs via passkey.

---

## Epic 14 — Cross-cutting & Release

### 69. Offline screen + connectivity — `epic:release`
**Goal:** Handle loss of connectivity gracefully by detecting network state and showing a
dedicated offline screen instead of failing silently. Combined with the outbox (#22), this
lets users understand what's happening and queue actions to run when they're back online.
**Create:** `frontend/mobile/app/offline.tsx`; connectivity provider.
**Port/reference:** `frontend/wallet/app/offline/page.tsx`.
**Deps:** `@react-native-community/netinfo`.
**Acceptance:** offline shows the offline screen + queues actions (ties to #22).

### 70. Deep linking config — `epic:release`
**Goal:** Register the `veil://` custom scheme and platform universal/app links so payment
requests and external entry points open the right screen. This must work from both a cold
start and a warm resume, and underpins the SEP-7 handling from #38.
**Modify:** `app.config.ts` — `scheme: 'veil'`, iOS associated domains, Android intent filters; wire expo-router linking.
**Port/reference:** #38 SEP-7 handler.
**Acceptance:** cold-start + warm-start deep links route correctly.

### 71. E2E tests (Maestro) — `epic:release`
**Goal:** Protect the critical paths with automated device tests covering create-wallet,
send, and receive, including a real-device passkey smoke test. Porting the web e2e
scenarios to Maestro gives confidence that core flows keep working as the app evolves.
**Create:** `frontend/mobile/.maestro/` flows for create-wallet, send, receive (skip first-run tutorial per #27).
**Port/reference:** `frontend/wallet/e2e/` scenarios.
**Acceptance:** Maestro flows pass on emulator + a real-device passkey smoke test.

### 72. EAS build + store metadata — `epic:release`
**Goal:** Turn the project into shippable builds by configuring EAS profiles and drafting
store listing assets and metadata. Android goes first since its asset links are self-serve
(#19), with iOS following once the Apple account and associated domains (#18) are in
place.
**Create:** `frontend/mobile/eas.json` (dev/preview/production profiles); store listing assets + metadata.
**Notes:** Android first (self-serve asset links, #19); iOS after Apple account + #18.
**Acceptance:** `eas build -p android --profile preview` produces an installable build; store metadata drafted.
