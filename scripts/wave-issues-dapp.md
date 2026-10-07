# Wave batch 18 — dApp browser, follow-ups, and web/mobile parity (DRAFT)

**Repo:** `Miracle656/veil`. **IDs:** V211–V240. **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** create the `epic:dapp-browser` label. `epic:dapp`, `epic:agent`, `epic:invest`, `epic:privacy`, `area:*` all exist.

## What is already built, and what is not

Veil can already be *connected to*: `frontend/wallet/lib/walletConnect.ts` and `frontend/mobile/lib/walletConnect.ts` implement WalletConnect pairing, with `ConnectDAppModal` and `WalletConnectApprovalModal` in the wallet and the subscription wired in `frontend/mobile/app/_layout.tsx`. Issues #495 and #496 closed that work.

What does not exist is a **browser**. There is no `dapp`, `browser` or `discover` route in either app, no dApp directory, and `react-native-webview` is not a dependency. So a user can approve a request from a dApp they already have open somewhere else, and cannot discover or open one from inside Veil.

V211–V218 build that. V219–V230 are follow-ups from reviewing this week's PRs — every one is a defect that was found in real code, not invented scope.

## Shared with every issue

### The signing ceremony is not to be reimplemented

Veil's smart wallet authorises spending through Soroban's `__check_auth`, and getting that right needs six non-obvious things together: the host function, a low-S signature, an expiration ledger, a footprint recovered by re-simulation, the right sequence, and a 5-element signature vector.

`frontend/mobile/lib/walletConnect.ts` already implements all of it in `signXdrPayload()` (line 273), via `signAuthEntry()` and `registerAuthEntrySigner()`. **Every new path that signs anything must call into that**, not build its own. A second signing path is how a wallet ends up with one that is subtly wrong.

### Ground rules

- **Never call the SDK's `register()` outside the create-wallet flow.** It overwrites `invisible_wallet_key_id` / `_address` / `_public_key` and strands the wallet.
- **Pin assets by issuer, never by code.** Eight issuers publish an asset called `USDT0` on mainnet; a code match is not an asset match.
- **Validate every hard-coded `C…`/`G…`** with `StrKey.isValidContract` / `isValidEd25519PublicKey`, and derive SAC ids rather than pasting them.
- **No secrets in committed files**, and never log or render an RPC URL — QuickNode keys live in the URL path.
- `frontend/mobile` installs with **plain `npm install`** (never `--legacy-peer-deps`, which corrupts its lockfile) and tests with jest via `jest-expo`. `sdk/` does need `--legacy-peer-deps`.
- Mobile main is green at 53 suites / 611 tests with `tsc --noEmit` clean. A typecheck error will turn main red, and fork PRs run no CI here — so verify locally before you push.
- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.

---

### V211 · A dApp browser shell, with an explicit allow-list

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:dapp-browser

### Background
There is no browser in the app. This is the shell everything else in this group builds on, and it should land deliberately small: a WebView, an address bar that is not free-text, and nothing that can sign.

An in-app browser inside a wallet is a security surface before it is a feature. Starting from an allow-list means the risky version never ships by accident.

### What to build
- Add `react-native-webview` (it is not currently a dependency) and a `dapp` route outside the tab group.
- A curated allow-list of dApp origins in one module, with the origin, display name and a short description. No free-text URL entry in this issue.
- The WebView loads only an allow-listed origin over HTTPS. Anything else is refused with a message naming the origin.
- No wallet API is injected yet — this shell can browse and nothing more.

### Acceptance criteria
- [ ] A non-allow-listed origin cannot be loaded, including via a redirect
- [ ] `http://` is refused even for an allow-listed host
- [ ] No wallet object, key or address is reachable from page JavaScript
- [ ] Tests cover the allow-list decision, including a redirect to a different origin

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V212 · A dApp directory people can actually browse

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:dapp-browser

### Background
An allow-list is a config file. A directory is what makes it usable: a screen listing the Stellar dApps Veil supports, with enough context to choose one.

### What to build
- A list screen rendering the allow-list from V211: name, icon, one-line description, category.
- Each entry opens the browser shell at that origin.
- An empty state and a search filter over name and category.

### Acceptance criteria
- [ ] Entries come from the same module as the allow-list, so the two cannot drift
- [ ] Tapping an entry opens exactly that origin
- [ ] Search matches name and category, and shows an empty state on no match
- [ ] Tests cover filtering and the empty state

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V213 · Inject a Stellar provider that signs only through the existing ceremony

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:advanced, epic:dapp-browser

### Background
This is the issue that makes the browser a wallet browser, and the one most likely to introduce a vulnerability. A page gets an object it can call; every call must cross a boundary the user controls.

`signXdrPayload()` in `frontend/mobile/lib/walletConnect.ts:273` already does the hard part correctly. This issue exposes it to a page — it does not reimplement it.

### What to build
- Inject a minimal provider into an allow-listed page: request the wallet address, sign a transaction, sign an auth entry. Nothing else.
- Every signing call routes through `signXdrPayload()` / `registerAuthEntrySigner()`. No new signing path, no key material in the WebView.
- Every call is gated on an explicit user prompt showing the origin, the operation, the asset and the amount. A page must not be able to suppress, style or auto-confirm it.
- Messages carry the origin, and the handler verifies it against the loaded origin — a frame must not be able to speak for its parent.
- An unknown method is rejected with an error, never silently ignored.

### Acceptance criteria
- [ ] A page cannot obtain a private key, a seed, or the fee-payer secret by any call
- [ ] Every signature is preceded by a prompt naming the origin
- [ ] A message whose origin does not match the loaded origin is rejected
- [ ] Rejecting leaves no partial state and returns a clean error to the page
- [ ] Tests cover origin mismatch, unknown method, and user rejection

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V214 · Per-origin permissions the user can see and revoke

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:dapp-browser

### Background
Once a page can ask for a signature, "which sites have I allowed, and what did I allow them to do" has to be answerable and reversible. WalletConnect sessions already have this shape in `getWalletConnectSessions()`; browser origins need their own.

### What to build
- Persist per-origin grants: address disclosure and signing, separately, with when they were granted.
- A settings screen listing every origin with a grant, and a revoke action per origin and an all-at-once.
- Revoking takes effect immediately in an open page, not on next load.

### Acceptance criteria
- [ ] Granting for one origin grants nothing for another
- [ ] Revoking mid-session causes the next call from that page to prompt again
- [ ] Grants survive an app restart, and clearing them is permanent
- [ ] Tests cover grant, revoke and the isolation between origins

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V215 · Name the origin on every signing prompt

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:dapp-browser

### Background
The existing approval modal was written for WalletConnect, where the peer is named by the session. A browser prompt has to show which *page* is asking, and show it in a way a page cannot fake.

### What to build
- Every signing prompt shows the full origin, rendered by the app chrome and never by page content.
- Long or lookalike hosts are handled deliberately — show the registrable domain prominently, the full origin in full, and do not truncate in a way that hides the end of a host.
- The same treatment for the WalletConnect approval path, so the two agree.

### Acceptance criteria
- [ ] The origin shown is the one that will be signed for, in every path
- [ ] A long or unicode host cannot be rendered to look like another host
- [ ] Nothing from the page can alter the prompt's text or styling
- [ ] Tests cover a long host and a unicode lookalike

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V216 · Keep navigation inside the origin the user approved

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:dapp-browser

### Background
A permission granted to one origin must not follow the user to another. A link, a redirect or a popup that leaves the approved origin has to drop the grant.

### What to build
- Intercept navigation. Leaving the approved origin either opens in the system browser or asks, and never carries the grant with it.
- Block `window.open` into a new in-app context that would inherit permissions.
- Show the current origin in the browser chrome at all times, updating on navigation.

### Acceptance criteria
- [ ] A redirect to a different origin drops the grant
- [ ] The displayed origin always matches what is loaded
- [ ] A popup cannot obtain the opener's permissions
- [ ] Tests cover redirect and popup

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V217 · Clear browsing data and end every dApp session

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:dapp-browser

### Background
A browser accumulates cookies, storage and cache. In a wallet that is both a privacy question and a support answer, and there is currently nowhere to do it.

### What to build
- A Settings action clearing WebView cookies, local storage and cache, and revoking every origin grant.
- Say what will be cleared before doing it, and confirm afterwards.
- Ensure it also ends WalletConnect sessions, so "disconnect everything" means everything.

### Acceptance criteria
- [ ] Cookies, storage and cache are all cleared, verifiably
- [ ] Every origin grant and WalletConnect session ends
- [ ] The wallet itself, its passkey and its keys are untouched
- [ ] Tests assert the wallet survives and the grants do not

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V218 · Web parity for dApp discovery

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:dapp-browser

### Background
The desktop wallet cannot embed a WebView the way mobile does, and should not try — a browser inside a browser adds a signing surface with none of the isolation. Parity here means discovery, not embedding.

### What to build
- A directory screen in the web wallet reading the same allow-list module as V212.
- Entries open the dApp in a new tab, and the user connects through the existing WalletConnect flow.
- One shared module for the list, so adding a dApp is a single edit.

### Acceptance criteria
- [ ] Web and mobile render the same list from one source
- [ ] Web opens in a new tab and never embeds
- [ ] Adding an entry requires exactly one file change
- [ ] A test fails if the two apps could diverge

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V219 · Remove the remaining silent testnet fallbacks

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:hardening

### Background
#703 removed the hard-coded testnet passphrase and anchor defaults from three files. Four more survived, and one of them is worse than the ones that were fixed:

- `frontend/wallet/lib/sep24.ts:54` — `networkMatch ? … : Networks.TESTNET`, byte-for-byte the defect just fixed in mobile's `sep24.ts`, still live on the web buy/withdraw path.
- `frontend/wallet/app/withdraw/page.tsx:40-42` — `NEXT_PUBLIC_SEP24_ANCHORS?.split(',')[0] || 'testanchor.stellar.org'`.
- `frontend/mobile/lib/backupFile.ts:36,85` — `TESTNET_PASSPHRASE` as a fallback.
- `frontend/mobile/lib/assets.ts:20` — `HORIZON_URL = EXPO_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org'`, ignoring the active network entirely, so on mainnet the portfolio screen queries testnet Horizon.

### What to build
- Each falls back to nothing. Where a value is genuinely required, throw with a message naming the missing variable.
- The active network decides the Horizon URL; no module picks its own.
- Tests that fail before and pass after, in the shape #703's did — assert the mainnet path rejects rather than silently substituting.

### Acceptance criteria
- [ ] No non-test source under `frontend/` resolves a testnet default on a mainnet path
- [ ] `lib/assets.ts` reads Horizon from the active network
- [ ] Testnet still works with its own configuration
- [ ] A test covers each of the four sites

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V220 · One asset registry, not two

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:invest

### Background
`frontend/wallet/lib/assets.ts` and `frontend/mobile/lib/assets.ts` are hand-maintained copies of the same issuer table, and `packages/agent/src/assets.ts` is now a third. They have already diverged: the agent's copy dropped `getAssetIssuer()`, and two open PRs each propose a fourth module.

For a table whose entire job is to say which issuer is genuine, divergence *is* the vulnerability.

### What to build
- One source of truth. `packages/agent` is published standalone and cannot import from the apps, so the dependency runs the other way: the agent exports the registry and both apps re-export from it.
- Where a shared import is genuinely impossible, a parity test that fails when any copy is edited alone.
- Delete the duplicates rather than leaving them as re-exports that can drift again.

### Acceptance criteria
- [ ] Adding an asset requires exactly one edit
- [ ] A deliberate divergence fails a test
- [ ] Every consumer resolves by issuer, and no consumer matches on code alone
- [ ] No behaviour change for existing assets

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V221 · Give the agent's invest hand-off somewhere to land

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:easy, epic:agent

### Background
The agent can produce an `investIntent`, and the API returns it, but nothing reads it: the wallet's agent page and `frontend/mobile/lib/agentClient.ts` both parse only `swapIntent`. So a user asks to buy an asset, the agent says it is ready on the invest screen, and nothing opens.

### What to build
- Parse `investIntent` in both clients, mirroring exactly how `swapIntent` is handled today.
- Route to the existing earn screen (`frontend/wallet/app/earn/page.tsx`, `frontend/mobile/app/(tabs)/earn.tsx`) pre-filled with the asset and amount.
- Keep the prepared intent if the closing reply fails, the way the swap path does.

### Acceptance criteria
- [ ] An invest hand-off opens the screen pre-filled, on both platforms
- [ ] The asset is carried by issuer, not code
- [ ] A malformed intent is ignored rather than opening a blank screen
- [ ] Tests cover parse, route and the malformed case

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V222 · Honour `memo_type` in payment links

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:easy, epic:send-receive

### Background
`frontend/wallet/lib/sep7.ts` parses `memo` and never `memo_type` — its `Sep7Parsed` has no such field — and `app/send/page.tsx:309` attaches `Memo.text()` unconditionally.

So `web+stellar:pay?…&memo=12345&memo_type=MEMO_ID`, the standard exchange-deposit form, sends a **text** memo where an **id** memo was asked for, and the exchange does not credit it. Attaching the wrong type is worse than attaching none, because it looks like it worked.

### What to build
- Parse `memo_type` in `lib/sep7.ts` and switch on it: `Memo.id`, `Memo.hash`, `Memo.return`, `Memo.text`.
- An unsupported or malformed `memo_type` refuses the link rather than guessing.

### Acceptance criteria
- [ ] `MEMO_ID`, `MEMO_TEXT`, `MEMO_HASH` and `MEMO_RETURN` each produce the right memo
- [ ] An unknown `memo_type` is refused with a message naming it
- [ ] A link with `memo` and no `memo_type` behaves as today
- [ ] Tests cover all four types plus the refusal

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V223 · Validate memo length before signing, not after

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:easy, epic:send-receive

### Background
A memo from a deep link or QR is untrusted input, and `Memo.text()` throws above 28 bytes. On web the throw is caught by the outer handler and routed through `passkeyErrorMessage()`, so a too-long memo is reported to the user as a passkey error. Mobile already guards this at `frontend/mobile/lib/sendPayment.ts:193`.

### What to build
- Validate the memo's byte length — not its character length — before building the transaction, and show a real validation message naming the limit.
- Mirror mobile's guard rather than writing a second one.
- Mobile also currently *displays* a memo it will silently drop if it is too long; make that consistent.

### Acceptance criteria
- [ ] A 29-byte memo is refused with a validation message, not a passkey error
- [ ] Multi-byte characters are counted as bytes
- [ ] Web and mobile agree on the limit and the message
- [ ] Tests cover a multi-byte memo at the boundary

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V224 · One deep-link module, shared

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:easy, epic:send-receive

### Background
`frontend/wallet/lib/deepLinks.ts` is a near-verbatim copy of the mobile module, and only `resolvePaymentAsset` is imported anywhere — `resolveDeepLink` and its tests cover code the web wallet never calls. Two copies of a parser for untrusted input will drift, and the drift will be in the validation.

### What to build
- One module both apps import, or a parity test that fails when either is edited alone.
- Remove the unused surface rather than leaving it as tested dead code.

### Acceptance criteria
- [ ] Both apps accept and refuse exactly the same links, proven by a shared table of cases
- [ ] No exported function is unreachable from either app
- [ ] The existing refusal behaviour is unchanged

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V225 · Say when the fee-payer cannot cover the fee

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:send-receive

### Background
A Soroban contract cannot pay its own gas, so every transaction needs a funded `G…` fee-payer. When it is empty the failure arrives at submission as a network error, which is the worst possible place to learn it — and a recovered wallet starts with exactly that state.

### What to build
- Check the fee-payer's balance against the bid before building, and block with a clear message naming the amount needed and the address to send it to.
- Surface it on the screens that spend: send, swap, and trustline creation.
- Distinguish "account does not exist" from "exists but is short" — the remedies read differently.

### Acceptance criteria
- [ ] A short fee-payer is caught before signing, not at submission
- [ ] The message names the amount and shows the fee-payer address
- [ ] A missing account and a short account produce different messages
- [ ] Tests cover both states and the healthy one

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V226 · Stop the agent matching balances by asset code

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:easy, epic:agent

### Background
`packages/agent/src/txBuilder.ts:166-174` reads both `asset_code` and `asset_issuer`, then calls `getRegisteredAsset(code)` and aliases the balance under the bare code. The issuer is never used for the decision, so any trustline with a matching code — the standard impostor vector — is reported to the user under the registry's label.

The helper that fixes it is already in the module and unused.

### What to build
- Gate the alias on `isRegisteredIssuer(code, issuer)`.
- Report an unregistered issuer explicitly as unverified, with the issuer shown.

### Acceptance criteria
- [ ] A counterfeit trustline is never aliased to a registry entry
- [ ] The agent names the issuer when reporting a registered asset
- [ ] An unverified holding is reported as such, with its issuer
- [ ] A test covers a wallet holding both the real and a fake asset

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V227 · A parity test for the asset registries

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:easy, epic:invest

### Background
Until V220 lands, the registries are duplicated by hand, and nothing notices when one is edited alone. This is the cheap guard that catches it today.

### What to build
- A test asserting the wallet, mobile and agent registries hold the same codes with the same issuers, and that every entry passes `StrKey.isValidEd25519PublicKey`.
- It must run offline, with no network call.

### Acceptance criteria
- [ ] Editing one registry alone fails the test
- [ ] An invalid issuer address fails the test
- [ ] It runs with no network access
- [ ] The failure message names the diverging entry

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V228 · Prove `npm ci` works for every workspace

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy, epic:hardening

### Background
The mobile CI job ran a bare `npm ci` against a lockfile that had drifted, so it failed at install and **never ran the typecheck or the tests on any commit**. Nothing else noticed, because the job was already red for another reason. That gap is how an expo-constants API removed from under the app reached testers.

### What to build
- A CI job that runs `npm ci` in every workspace with a lockfile and fails on drift, separately from the jobs that use it — so an install failure is legible as an install failure.
- Where a job currently does `npm ci || npm install`, make the fallback visible in the log rather than silent.

### Acceptance criteria
- [ ] A deliberately drifted lockfile fails the check
- [ ] Every workspace with a lockfile is covered
- [ ] The failure names the workspace and the offending package
- [ ] No job silently masks a drifted lockfile

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V229 · Explain the reserve before it is spent

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:easy, epic:send-receive

### Background
Every trustline locks 0.5 XLM of the account's reserve. Users meet this as a balance that quietly went down, or as a send that fails for no visible reason. With USDT0 and USDY both arriving, more users will add trustlines.

### What to build
- Before a trustline is created, state the reserve cost and what it means — locked, not spent, released if the trustline is removed.
- On the balance view, show how much of the balance is reserved and why.

### Acceptance criteria
- [ ] The cost is shown before the trustline is created, on both platforms
- [ ] The reserved portion is visible on the balance view with its reason
- [ ] The number is derived from the account's actual subentry count, not hard-coded
- [ ] Tests cover an account with zero, one and several trustlines

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V230 · Turn the six `__check_auth` requirements into a test suite

**Labels:** help wanted, Stellar Wave, area:mobile, area:testing, difficulty:advanced, epic:hardening

### Background
Passkey signing against `__check_auth` needs six things right together: the host function, a low-S signature, an expiration ledger, a footprint recovered by re-simulation, the right sequence, and a 5-element signature vector. Getting any one wrong fails with an opaque error, and the knowledge currently lives in one function and one memory.

With the dApp browser adding a second caller of that path, the requirements need to be executable rather than remembered.

### What to build
- A suite asserting each requirement independently, against `signXdrPayload()`: a high-S signature is rejected, a 4-element vector is rejected, a stale expiration is rejected, a footprint that misses the wallet's storage is rejected.
- Each test must fail if its requirement is removed from the implementation — prove this by removing it, one at a time, and recording the result in the PR.
- Run it in CI on every change to the signing path.

### Acceptance criteria
- [ ] Each of the six has at least one test that fails when that requirement alone is broken
- [ ] The PR records what happened when each was disabled
- [ ] It runs in CI and is fast enough to run on every push
- [ ] A contributor can read the suite and learn the requirements from it

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

## Part 3 — web ↔ mobile parity

A route-by-route diff of `frontend/wallet/app` and `frontend/mobile/app` on 2026-09-24. Every screen below exists and is substantial on one platform and absent on the other — these are not naming differences. (`/activity` and `/transactions` are the same screen under two names, and mobile's `/pay` is a 29-line stub, so neither is listed.)

**Built on web, missing on mobile:** `nfts` (714 lines), `settings/danger` (614), `settings/profile` (252), `settings/fee-payer` (203), `settings/agent` (176), `settings/privacy` (109).

**Built on mobile, missing on web:** `settings/backup` (500), `settings/network` (365), `bulk-payout` (308), `settings/about` (278).

The backup one matters most. `frontend/wallet/lib/backup.ts` exists and the envelope format is deliberately identical across platforms — a file exported on mobile restores on web and the reverse — but **no web screen imports it**, so the library is unreachable. The encrypted backup is the recovery path for a passkey manager with no PRF, and today only mobile users can reach it.

---

### V231 · Mobile: NFTs

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:dashboard

### Background
`frontend/wallet/app/nfts/page.tsx` is 714 lines of working NFT browsing on web. Mobile has nothing.

### What to build
- An NFTs screen reading the same data the web screen reads, reusing shared logic rather than reimplementing the fetch.
- A grid of owned items with image, name and collection; tap through to a detail view.
- Empty, loading and failed states — a wallet with no NFTs must not look broken.

### Acceptance criteria
- [ ] The same wallet shows the same items on both platforms
- [ ] Metadata or image failures degrade to a placeholder, never a crash
- [ ] Empty and error states are visually distinct
- [ ] Tests cover empty, populated and failed-metadata

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V232 · Mobile: agent settings

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:agent

### Background
`frontend/wallet/app/settings/agent/page.tsx` lets a user configure the agent — name, language, persona, role. Mobile has the agent tab but no way to configure it.

### What to build
- A settings screen with the same fields, persisted the way other mobile settings are.
- The values feed the existing `profile` field on the agent request; no new API shape.

### Acceptance criteria
- [ ] The same fields as web, bounded to the same lengths
- [ ] Values reach the agent request and survive a restart
- [ ] Clearing a field removes it rather than sending an empty string
- [ ] Tests cover persistence and the request payload

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V233 · Mobile: the danger zone

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:settings

### Background
`frontend/wallet/app/settings/danger/page.tsx` is 614 lines covering wallet reset and other irreversible actions. Mobile has no equivalent, so a user who needs to start over has no supported way to do it.

This is the screen where a mistake cannot be undone, so it needs more care than its size suggests.

### What to build
- Reset wallet, behind an explicit typed confirmation, matching web's wording.
- Before destroying anything, state plainly what is lost and what is not — and route the user to the backup screen first.
- Clear the wallet store, the SDK keys and cached state, leaving nothing that makes a half-reset wallet.

### Acceptance criteria
- [ ] Reset requires an explicit confirmation, not a single tap
- [ ] The user is offered a backup before the destructive action
- [ ] After reset the app returns to onboarding with no stale state
- [ ] Tests assert every wallet key is cleared

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V234 · Mobile: fee-payer settings

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:settings

### Background
`frontend/wallet/app/settings/fee-payer/page.tsx` shows the fee-payer account and its diagnostics. On mobile the fee-payer is invisible until a transaction fails for want of gas — which is exactly the state a recovered wallet starts in.

### What to build
- Show the fee-payer address, its balance, and how it was derived (passkey PRF, or a random fallback).
- A copy action and a QR, so funding it does not mean retyping a 56-character address.

### Acceptance criteria
- [ ] Address, balance and derivation source are all shown
- [ ] A random-fallback fee-payer is identified as such
- [ ] The QR encodes the fee-payer, never the smart wallet address
- [ ] Tests cover both derivation states

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V235 · Mobile: privacy settings

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:privacy

### Background
`frontend/wallet/app/settings/privacy/page.tsx` exists on web; mobile has no privacy settings screen. With the SPP work landing, mobile needs the same surface.

### What to build
- Mirror the web screen's options, reading the flag through `lib/privacy/config.ts` so the mainnet lockout applies identically.
- Where a feature is not yet available on mobile, say so rather than showing a control that does nothing.

### Acceptance criteria
- [ ] The flag is read from the shared config, not a local copy
- [ ] Nothing is toggleable on mainnet
- [ ] Unavailable options are labelled, not hidden and not faked
- [ ] Tests cover the mainnet lockout

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V236 · Mobile: profile settings

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:settings

### Background
`frontend/wallet/app/settings/profile/page.tsx` is 252 lines on web with no mobile equivalent.

### What to build
- The same profile fields, persisted through the existing mobile settings store.
- Validate and bound every field, matching web's limits.

### Acceptance criteria
- [ ] Fields, limits and validation match web
- [ ] Values survive a restart
- [ ] No personal data is written anywhere it could reach a URL or a log
- [ ] Tests cover validation and persistence

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V237 · Web: make the encrypted backup reachable

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:recovery

### Background
`frontend/wallet/lib/backup.ts` implements the encrypted backup — AES-256-GCM over a PBKDF2-SHA256 key — and the wire format is deliberately byte-identical to mobile's, so a file exported on one restores on the other. **No web screen imports it.** The library is complete and unreachable.

This is not cosmetic. The encrypted backup is the recovery path for a passkey manager that does not implement PRF, and it carries the wallet's `C…` address and passkey public key — exactly what a fresh device needs to find the wallet again. Today only mobile users can produce one.

### What to build
- A Settings → Backup screen: export with a passphrase, and restore from a file.
- Mirror `frontend/mobile/app/settings/backup.tsx` in behaviour, including the minimum passphrase length and the "there is no way to recover this passphrase" warning.
- Prove cross-platform compatibility with a test that restores a fixture produced by the mobile path.

### Acceptance criteria
- [ ] A backup exported on web restores on mobile and the reverse, proven by a committed fixture
- [ ] A wrong passphrase or an altered file raises a tamper error and changes nothing on the device
- [ ] No private key, seed or mnemonic reaches the file — assert with `assertNoSecretMaterial`
- [ ] The passphrase is never persisted or logged

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V238 · Web: an About screen that says which build is running

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:easy, epic:settings

### Background
`frontend/mobile/app/settings/about.tsx` shows the version, the network, the contract addresses and where to get help. Web has no equivalent, so a user reporting a bug cannot say which build they are on.

### What to build
- The build identifier from the deployment (the commit SHA is available at build time), the active network, the factory and wallet contract addresses, and support links.
- Reuse mobile's `redactEndpoint` treatment: **never render an RPC URL verbatim**, because the provider key lives in its path.

### Acceptance criteria
- [ ] The build identifier matches the deployed commit
- [ ] No RPC URL is rendered with its path intact
- [ ] The contract addresses shown are the ones actually in use
- [ ] A test asserts the redaction

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V239 · Web: switch network without a redeploy

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:settings

### Background
`frontend/mobile/app/settings/network.tsx` is 365 lines letting a user move between mainnet and testnet. On web the network is fixed at build time by `NEXT_PUBLIC_NETWORK`, so changing it means a redeploy.

Wallet state is already namespaced per network, so the storage half of this exists.

### What to build
- A network switcher writing to the same per-network storage the mobile app uses.
- Switching re-reads balances, contract addresses and the RPC endpoint, with no stale state from the previous network.
- The active network is visible at a glance, not buried in settings.

### Acceptance criteria
- [ ] Switching never mixes balances or addresses between networks
- [ ] A passkey created on one network is not offered on the other
- [ ] The build-time default still applies on first load
- [ ] Tests cover a switch with state present on both networks

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V240 · Web: bulk payout

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:send-receive

### Background
`frontend/mobile/app/bulk-payout.tsx` is 308 lines paying many recipients in one flow. Web — the platform someone would actually run a payroll from — cannot do it.

### What to build
- Paste or upload a recipient list, validate every row before anything is signed, and show a total.
- Per-row validation: address, asset by issuer, amount, and an optional memo with the same byte limit as a single send.
- Partial failure is reported per row; a failed row must never be silently skipped.

### Acceptance criteria
- [ ] An invalid row blocks submission and is identified by row number
- [ ] Assets resolve by issuer, never by code
- [ ] The total, including fees, is shown before signing
- [ ] Partial failure reports exactly which rows succeeded
- [ ] Tests cover a malformed row, a bad asset and a partial failure

> **Drips Wave** · Complexity: **Intermediate** · **150 points**
