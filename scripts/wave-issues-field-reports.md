# Wave batch — field reports (V276–V288)

Drafted 2026-10-14 from a week of real tester sessions on mainnet. Every issue
below was observed on someone's phone or browser, not imagined. Where a fix
shipped for part of it, the issue says what is left.

## Shared with every issue

**Repo:** `Miracle656/veil`. The mobile app is `frontend/mobile` (Expo / React Native); the web wallet is `frontend/wallet` (Next.js). They share an SDK in `sdk/`.

**Run the tests:** `npm test` in the workspace you touched. Mobile is `jest-expo`; install with plain `npm install`, **never** `--legacy-peer-deps` — that corrupts the lockfile. Two web suites (`csp.test.ts`, `registryParity.test.ts`) are red on the `feat/buy-with-naira` branch and green on `main`; if you are working from the branch, that is V283's job and not yours.

**This wallet holds real money on mainnet.** The passkey signs a Soroban contract call, and a wallet address is derived from the passkey's public key — so anything touching registration, derivation or signing can strand funds permanently. No Veil contract is upgradeable. When in doubt, say so in the PR rather than guessing.

**Never elide an address in code or docs.** A previous batch wrote `CD2W5LUR…XZ4L` in an issue and five contributors invented plausible-looking contract ids to fill the gap. Write the whole thing or do not write it.

---

### V276 · Buying airtime succeeds and the screen never says so

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:ngn-rails

### Background
A user bought airtime, signed with their passkey, and **received the airtime** — then sat on a loading screen that never resolved. They saw this on 2026-10-12 and again since. The purchase works; only the UI never reaches a terminal state.

Worth knowing before you start, because it cost an afternoon last time: the first theory was that the status regex missed `completed`. That was wrong — the provider confirmed the status is literally `completed`. The actual cause then was a poll error being swallowed silently, so the screen kept waiting on a request that had already failed.

### What to build
- Find why the terminal status never reaches the screen in `frontend/mobile/app/airtime.tsx`. Suspect the poll's error handling before the status matching.
- A failed poll must be distinguishable from a pending one. Retrying silently forever is what produced this.
- A bounded wait with an honest end: after it, say what is known — the money left, the top-up may already have arrived, here is how to check.

### Acceptance criteria
- [ ] A completed bill reaches a done state, with a test driving the real status value
- [ ] A poll that errors is retried visibly and gives up with an explanation, not a spinner
- [ ] The screen never waits indefinitely
- [ ] A user who has already received the airtime is never told the purchase failed

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V277 · The agent's reply renders on top of its own input box

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:agent

### Background
A screenshot from 2026-10-13 shows the assistant's reply — "No unverified holdings. Want me to pull your recent transfer history…" — drawn directly over the suggestion chips and the input placeholder. Two layers of text occupy the same pixels and both are unreadable.

The composer was reworked recently to sit above the keyboard (`KeyboardStickyView` with a `liftedBy` offset applied to the thread's padding). That fixed the keyboard-open case. The resting case — keyboard dismissed, thread at its natural height — was not covered, and the thread's bottom padding does not clear the composer.

### What to build
- The last message must be fully visible above the composer with the keyboard closed, at every supported text size.
- Work out whether the thread's padding is wrong or the composer's measured height is, rather than adding a constant until it looks right on one device.
- Check it with one message, with a thread longer than the screen, and with dynamic type at its largest.

### Acceptance criteria
- [ ] The last message clears the composer with the keyboard closed
- [ ] It still clears it with the keyboard open, so the earlier fix is not regressed
- [ ] Correct at the largest system font size
- [ ] A test or snapshot pins the clearance rather than relying on a visual check

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V278 · Swap is the one money path that never charges the platform fee

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:advanced, epic:fees

### Background
The Veil fee is collected on-chain, in the same transaction as the thing the user is doing. Send charges it. Cash-out and airtime charge it through `spendAsset`. The web wallet charges it. **Swap does not**, and has not since the fee shipped.

Swap is a third code path (`soroswap` / `sdexSwap`) that neither `spendAsset` nor `sendPayment` passes through, so it was missed when the other two were wired.

The constraint that shaped the others applies here too: a Stellar transaction may carry at most **one** Soroban operation. A swap executed as a contract invocation therefore has nowhere to put a second payment, exactly as the SAC transfer path does not. The classic SDEX path has room for an operation; the Soroswap path may not. That difference is the heart of this issue, not an aside.

### What to build
- Charge the fee on the swap paths where a transaction can carry it, using `fetchPlatformFee(assetCode, amount)` so the server prices it.
- Where the one-operation rule makes it impossible, say so in a comment and do not fake it — an unfeeable path is a decision, not an omission.
- Affordability is checked before the operation is added. A fee the user did not ask for must never be the reason their swap fails.

### Acceptance criteria
- [ ] A swap that can carry a fee charges the amount the server quoted for that size
- [ ] A path that cannot carry one is documented, with the reason
- [ ] An unaffordable fee means no fee, never a failed swap
- [ ] A test proves the user's own operation is unaffected when the fee is dropped

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V279 · A classic wallet's key cannot be backed up, so a lost phone is a lost wallet

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:advanced, epic:recovery

### Background
Some phones cannot create a passkey at all — a Redmi Note 11 5G returned `createCredentialAsync no provider dependencies found`, and no setting on that device exposed a credential provider. For those users the classic keypair wallet is the only option, and the rails already work for it: `spendAsset` takes the classic branch when the stored address is not a `C…`, and `requirePasskey()` no-ops when there is a signer secret and no passkey.

What does not work is recovery. There is no reveal-or-export screen anywhere, and `lib/backup.ts` **deliberately strips** private key material from exports — the scrubber matches `privatekey`, `secret` and `seed`, described as "the last line of defence". So the secret exists in exactly one keychain, and an uninstall destroys the wallet silently.

### What to build
- A one-time secret export for a keypair wallet: reveal it, behind the app lock, with the consequences stated before it is shown.
- It must be obvious that this is the only copy and that anyone holding it holds the money.
- Do **not** weaken the backup scrubber. The encrypted backup is designed to be safe to put in a cloud drive; a secret belongs somewhere the user chose deliberately, not in a file they will sync without thinking.
- Import already exists, so the round trip should work end to end once export does.

### Acceptance criteria
- [ ] A keypair wallet's secret can be revealed once, behind the lock
- [ ] A smart wallet does not offer this, since its key never leaves the passkey
- [ ] The backup scrubber still rejects secrets, with its test intact
- [ ] Export then reinstall then import restores the same address, proven end to end

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V280 · A second device cannot be registered, and the screen says so rather than solving it

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:advanced, epic:recovery

### Background
`app/settings/passkeys.tsx` is read-only by design, and its header explains why at length: an "Add a passkey" button called the SDK's `register()`, which overwrites `invisible_wallet_key_id`, `invisible_wallet_address` and `invisible_wallet_public_key` — repointing the device at a different wallet and stranding the money. It would then have failed anyway, because the SDK builds a four-element signature vector where the contract requires five.

So the screen honestly says a second device is not supported. That is better than losing someone's funds, and it is still a wallet that cannot be used from two devices.

### What to build
- Hold more than one credential at a time without disturbing the primary binding. That is the piece of work; the button is the easy part.
- Fix the signature vector length so `addSigner` can succeed from the app, or establish that it cannot and say where the real limit is.
- Registering a second device must be impossible to confuse with replacing the first, in the storage layer as much as in the UI.

### Acceptance criteria
- [ ] A second passkey can be registered without changing the wallet address or the fee-payer
- [ ] The new signer appears in the on-chain signer list
- [ ] Either device can then sign a payment, proven on-chain on testnet
- [ ] The existing warning in `passkeys.tsx` is rewritten or removed, not left contradicting the code

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V281 · Two passkey libraries, three years apart, doing the same job

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:advanced, epic:passkeys

### Background
`frontend/mobile/package.json` depends on both:

| Package | Used by | `credentials-play-services-auth` |
|---|---|---|
| `react-native-passkey` | the SDK, for registration | **1.6.0** |
| `react-native-passkeys` | `lib/passkey.ts`, for assertions and PRF | **1.3.0-alpha01** |

Gradle resolves to the newer artifact, so the build is currently fine. But two libraries wrapping the same platform API, pinning versions three years apart, is a resolution accident away from a device-specific failure that is very hard to diagnose — and one tester already hit `no provider dependencies found` on a phone that demonstrably creates passkeys in a browser.

### What to build
- Pick one library and move everything to it, or establish why both are genuinely needed and write that down where the next person will look.
- Whichever survives must support what the app actually uses: registration with the PRF extension enabled, assertion with PRF evaluation, and discoverable assertion with no `allowCredentials`.
- Check the resolved Android dependency tree before and after and put both in the PR.

### Acceptance criteria
- [ ] One passkey library, or a written reason for two
- [ ] Creation, assertion, PRF and discoverable sign-in all still work on a device
- [ ] The resolved `androidx.credentials` versions are stated in the PR
- [ ] No behaviour change in `lib/__tests__/` for passkey paths

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V282 · The SDK reads a field from an assertion that native never provides

**Labels:** help wanted, Stellar Wave, area:sdk, difficulty:intermediate, epic:passkeys

### Background
`sdk/src/core.ts`'s login path derives a wallet address from an assertion:

```ts
if (assertResult.publicKeyBytes && assertResult.publicKeyBytes.length === 65) {
  candidateAddress = computeWalletAddress(factoryAddress, assertResult.publicKeyBytes, networkPassphrase)
}
```

with a comment saying the provider "now exposes publicKeyBytes when the authenticator supports SPKI export on assertion responses". On React Native it does not: `sdk/src/webauthn.native.ts` returns `publicKeyBytes` from `create()` and never from `authenticate()`. So on mobile this branch is unreachable and the path it guards silently does nothing.

It matters because the public key genuinely **is** recoverable from an assertion — `frontend/mobile/lib/recoverPasskeyKey.ts` does it with ECDSA public-key recovery — and the SDK could use that instead of a field it will never receive.

### What to build
- Either populate `publicKeyBytes` on the native assertion path where the platform allows it, or remove the branch and recover the key from the signature as the mobile helper does.
- If recovery is the answer, it belongs in the SDK rather than only in the app, since the web wallet has the same problem.
- The comment must end up true either way.

### Acceptance criteria
- [ ] The branch either works on native or is gone
- [ ] A test covers whichever path survives
- [ ] The comment matches the behaviour
- [ ] Web and mobile resolve a wallet from an assertion the same way

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V283 · Two web suites are red on the feature branch and green on main

**Labels:** help wanted, Stellar Wave, area:web, difficulty:intermediate, epic:ci

### Background
`frontend/wallet` passes cleanly on `main` — 61 suites, every test green. On `feat/buy-with-naira` the same two fail every time: `lib/__tests__/csp.test.ts` ("allows a SEP-1 read for every registered issuer home domain") and `lib/__tests__/registryParity.test.ts` (fails to run at all).

Something on that branch broke them and nobody noticed, because they were attributed to whatever change was in flight at the time. They have to be green before the branch can merge, and a suite that fails to *run* is hiding whatever else it would have checked.

### What to build
- Find the branch change that broke each, and fix the cause rather than the assertion.
- `registryParity` fails at load — that is a different class of problem from a failing assertion and is worth understanding first.
- The CSP test exists so a registered issuer's home domain cannot be read without being in the policy; if the registry grew, the policy needs to grow with it.

### Acceptance criteria
- [ ] Both suites pass on the branch
- [ ] The PR names the change that broke each
- [ ] Neither is fixed by weakening what it asserts
- [ ] `middleware.js`'s allow-list and `lib/assets.ts` are back in step, with the test proving it

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V284 · "Bills & airtime" on the web is a mockup with disabled tiles

**Labels:** help wanted, Stellar Wave, area:web, difficulty:advanced, epic:ngn-rails

### Background
`frontend/wallet/app/bills/page.tsx` renders eight service tiles — Airtime, Data, Power, TV, Water, Transfer, Betting, Education — every one of them `aria-disabled="true"` with `title="Not available yet"` at 60% opacity. There are no API calls behind it. It is 91 lines of shell.

It sits in the main navigation, so a user clicks it, finds nothing, and learns the product is thinner than it looks. The mobile app has the real flow against the same backend, so this is a port rather than new ground.

### What to build
- Wire the bill flow to the existing `/ngn/bills` routes, following `frontend/mobile/app/airtime.tsx` for the sequence: reserve, pay from the wallet, poll to a terminal state.
- Ship only the categories that actually work and remove the rest. Eight disabled tiles is worse than one working one.
- The payment is crypto leaving the wallet, so it goes through the same signing path as any other spend, with the platform fee applied as elsewhere.
- V276 is the same flow's completion bug on mobile; read it before building the polling here.

### Acceptance criteria
- [ ] At least airtime works end to end on web, against the real backend
- [ ] Unimplemented categories are not shown
- [ ] A completed purchase reaches a terminal state, with no indefinite spinner
- [ ] The fee is charged consistently with the other web money paths

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V285 · A testnet wallet-creation function is reachable on mainnet

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:onboarding

### Background
`lib/testnetWallet.ts` exports `createTestnetWallet` and `importTestnetWallet`. The first makes a random keypair and funds it from Friendbot; on mainnet there is no Friendbot, so it returns an unfunded classic account with no passkey, no contract and no recovery. It was offered on the create screen as a peer of "Create with passkey" under the relabelled text "Use a classic keypair instead", and a tester took it after the passkey path failed on his device. His wallet was a `G…` address that could not receive.

The button is now hidden on mainnet. The naming is not fixed: functions called `*TestnetWallet` are still imported and called by mainnet code paths, and `importTestnetWallet` is still reachable from the mainnet import flow.

### What to build
- Rename to what they do — they create and import a classic keypair wallet, on whichever network is active.
- Make the network-dependent behaviour explicit rather than implied by a name: Friendbot funding is a testnet step, and the function should say so where it happens.
- Audit for other testnet-named code reachable from mainnet; this is unlikely to be the only one.

### Acceptance criteria
- [ ] No function named for testnet is called by a mainnet path
- [ ] Friendbot funding is clearly conditional, not an accident of a null URL
- [ ] The audit's findings are listed in the PR, even the ones not changed
- [ ] Existing behaviour is unchanged — this is naming and clarity, not a rewrite

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V286 · The fee-payer key for a non-PRF wallet is derived from a public value

**Labels:** help wanted, Stellar Wave, area:security, difficulty:advanced, epic:security

### Background
`sdk/src/deriveFeePayer.ts` derives the fee-payer keypair as `HKDF(credentialId, SALT, INFO)`. The wallet's own re-export carries the warning:

> **SECURITY:** the credential ID this derives from is not a secret, so the resulting key is not passkey-bound — anyone who can read the credential ID can reconstruct it.

This is the fallback used whenever the authenticator gives no PRF output, which on iOS is every browser except Safari, and on some Android password managers is always. Those users' gas accounts are protected by a value WebAuthn treats as public.

The blast radius is bounded — the smart wallet's own balance is passkey-bound through `__check_auth`, and only the fee payer is exposed — but the fee payer holds a real balance, and on a keypair wallet it holds everything.

### What to build
- Establish exactly where the credential id is exposed in practice, and write it down. That determines whether this is theoretical or live.
- Reduce what the legacy fee payer is trusted with, or stop deriving a spending key from a public value where an alternative exists.
- Whatever changes, a wallet already using the legacy derivation must not be stranded — the probe in `lib/feePayer.ts` that prefers an existing funded account is the pattern to follow.

### Acceptance criteria
- [ ] The exposure is documented with the actual paths the credential id travels
- [ ] Existing legacy wallets keep working, proven by a test
- [ ] Any new derivation is passkey-bound or the key holds nothing worth taking
- [ ] The warning in `deriveFeePayer.ts` is updated to match reality

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V287 · Nothing warns that a wallet is tied to the platform it was first spent from

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:onboarding

### Background
A Veil wallet can be signed from the platform that deployed it and nowhere else — the contract stores one WebAuthn origin at `init` and `__check_auth` compares it byte-for-byte, and web and native origins can never match. Issue **#1003** covers the contract-side fix.

Until that ships, the product has a permanent, invisible consequence and says nothing about it. A user picks a platform without knowing they are picking one, and finds out when they try to move and cannot. Testers have already hit this: they moved to the browser because their phone could not create a passkey, and their wallets are now browser-only for good.

### What to build
- Say it where it binds: at wallet creation, and again before the first spend, which is the moment the origin is fixed.
- Plain language. "This wallet will work in this app only" is true and understandable; "single-origin `__check_auth`" is neither.
- Sign-in on the other platform should explain why a wallet it can see cannot be used, instead of failing opaquely.

### Acceptance criteria
- [ ] Wallet creation states the platform consequence before a passkey is made
- [ ] The first spend restates it, since that is when it becomes permanent
- [ ] Attempting to sign from the wrong platform explains the cause
- [ ] The wording is removed in the same PR as #1003, not left behind as a lie

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V288 · Recovering a wallet's key from a signature has never run on a real device

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:advanced, epic:recovery

### Background
`lib/recoverPasskeyKey.ts` recovers a wallet's P-256 public key from a WebAuthn assertion by ECDSA public-key recovery, disambiguating candidates by deriving the wallet address. It exists because wallets reached mainnet with their public key recorded nowhere, holding real money at an address that could not be deployed — and it worked: a stranded wallet was repaired and spent from on 2026-10-13.

What has not been exercised is the second-signature tie-break. When no candidate shows on-chain evidence — an undeployed, empty wallet — the code asks for a second assertion and intersects the candidate sets. That path has unit tests with synthetic signatures and has never run against a real authenticator, where signatures may be deterministic in ways the tests assume they are not.

### What to build
- Exercise the tie-break on a device with an empty, undeployed wallet, and record what happens.
- If an authenticator produces identical signatures for the same challenge, the intersection is the whole set and the code refuses — correct, but worth confirming rather than assuming.
- Make the result reproducible: a documented procedure, so the next person does not have to rediscover how to get into this state.

### Acceptance criteria
- [ ] The tie-break is run on a real device and the outcome recorded in the PR
- [ ] A deterministic-signature authenticator is handled correctly, or shown not to exist in practice
- [ ] The procedure to reproduce an empty undeployed wallet is written down
- [ ] Any gap found is fixed or filed, not left in a comment

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V289 · Contract fuzzing has not run since September, while reporting panics it never found

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:advanced, epic:security

### Background
`.github/workflows/fuzz.yml` runs `fuzz_check_auth` and `fuzz_webauthn` every Monday. It has opened an issue titled "Fuzz panic" on 28 Sep, 5 Oct and 12 Oct. None of them is a panic. The step order on every run:

```
failure  Install cargo-fuzz
skipped  Run <target> (60 s)
success  Upload crash artifacts     (0 artifacts on the run)
success  Open issue on panic
```

`cargo install cargo-fuzz` fails resolution:

```
cargo-platform@0.3.3 requires rustc 1.91
cargo_metadata@0.23.1 requires rustc 1.86.0
Try re-running `cargo install` with `--locked`
```

Two defects, and the second is worse than the first. The install is unpinned, so it re-resolves transitive dependencies weekly and breaks whenever one of them moves. And both failure steps are gated on `if: failure()`, which fires when **any** earlier step fails — so a broken install is announced as a panic in `__check_auth`, the function that authorises every spend on a mainnet wallet.

The result is six weeks with no fuzzing of the contract's auth path, and six issues asserting the opposite. A security net that reports success when it is not running is worse than no net, because it is believed.

### What to build
- Pin the toolchain and install `cargo-fuzz` reproducibly — `--locked`, a pinned version, or a prebuilt binary. Weekly CI must not re-resolve a dependency graph.
- Separate "the fuzzer ran and found a panic" from "the job failed". Only the first should open an issue claiming a panic; the second should report a broken workflow and say so.
- Verify artifacts actually upload when there is a crash, since the current path has never been exercised.
- Run the fuzzers once by hand and report what they find on the current contracts — six weeks of real findings may be waiting.

### Acceptance criteria
- [ ] A fuzz run installs reproducibly and does not re-resolve dependencies
- [ ] A failed install reports a broken workflow, never a panic
- [ ] A genuine panic uploads its crash input and includes the reproducer in the issue body
- [ ] Both targets are run against current `main` and the result stated in the PR
- [ ] The issue body for a real panic is self-contained — a contributor can act on it without opening the run

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V290 · CI opens a new issue every night instead of updating one

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate, epic:ci

### Background
The nightly testnet smoke test has failed every night since 2026-09-25 and opened a fresh issue each time. Nineteen were open at once, carrying between them exactly the information of one. The weekly fuzz workflow does the same thing. Together they were a third of the repository's open issues, which buries the issues a contributor could actually pick up.

They are also unlabelled for points and unactionable: the body is a link to a workflow run, so nothing in them counts toward the Wave and nothing in them tells a contributor what to do.

### What to build
- A failing scheduled job should find its existing open issue and comment on it, opening a new one only when none is open.
- It should close or mark the issue when the job next passes, so a green test does not leave a red issue behind.
- Bodies should be self-contained: the failing step, the error, and what to check — not only a link to a run whose logs expire.
- Apply to both `fuzz.yml` and the nightly smoke workflow; they share the defect.

### Acceptance criteria
- [ ] A second consecutive failure comments rather than opening a new issue
- [ ] A subsequent pass closes or clearly resolves the open one
- [ ] The body contains the failing step and error, not just a run URL
- [ ] Both scheduled workflows use the same mechanism
- [ ] Verified by running the workflow twice, with the result in the PR

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V291 · The dApp browser injects no wallet, so no dApp can see Veil

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:advanced, epic:dapps

### Background
`frontend/mobile/app/dapp.tsx` injects exactly one thing into the WebView: a `window.open` blocker. There is no wallet provider, so a dApp loaded in Veil's own browser has nothing to connect to. Every Stellar dApp looks for a wallet on `window` — Freighter's `window.freighterApi` is the usual shape — finds nothing, and offers the user a list of wallets that does not include the one they are standing inside.

Veil already has every piece except the bridge. `registerAuthEntrySigner` takes a generic signer:

```ts
export type AuthEntrySigner = (payloadHash: Uint8Array) => Promise<WebAuthnSignature | null>
```

and `signPayloadWithPasskey` implements it against the device passkey. That path signs WalletConnect requests on mainnet today. What is missing is a provider object in the page that calls it.

### What to build
- A provider injected into the dApp WebView exposing at minimum `getAddress`, `signTransaction` and `signAuthEntry`, bridged over `postMessage` to the existing signer.
- Every request must be approved by the user, with the same scrutiny `WalletConnectApprovalModal` already applies — an injected wallet that signs silently is a wallet that drains accounts.
- Scope it to the page actually loaded. A provider that answers any origin in the WebView is an open door; the dApp allow-list in `@veil/dapps` already exists and should gate this.
- Decide the shape deliberately: SEP-43 is the standard and is what V292 targets, so do not invent a private API that then has to be migrated.

### Acceptance criteria
- [ ] A dApp in Veil's browser can discover the wallet and read its address
- [ ] A transaction signed through the provider is accepted by the wallet contract on testnet
- [ ] Every signature is approved explicitly, with the request shown
- [ ] An origin outside the allow-list gets no provider at all
- [ ] No private key, secret or credential id is reachable from the page

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V292 · Conform to SEP-43 so Veil is a wallet the ecosystem already knows how to talk to

**Labels:** help wanted, Stellar Wave, area:sdk, difficulty:advanced, epic:dapps

### Background
SEP-43 is Stellar's standard wallet interface. Stellar Wallets Kit — the connector most Stellar dApps use — keeps a `sep43Modules()` registry specifically for wallets that follow it exactly, alongside the general `defaultModules()`. A wallet in that list needs no bespoke handling by anyone.

Veil implements the same operations under its own names, across the app's WalletConnect handler and the SDK. Nothing claims SEP-43 conformance and nothing tests for it, so the gap between "we do roughly this" and "we do exactly this" is unmeasured — and that gap is the whole difference between being listed and not.

### What to build
- Read SEP-43 and write down, method by method, where Veil already conforms and where it does not.
- Implement the standard surface over the existing signer rather than beside it: one implementation, used by the injected provider from V291, by WalletConnect, and by the SDK.
- Conformance tests, so a future change that breaks the contract fails here rather than in someone else's dApp.
- Note that an auth entry is signed by the passkey and that `__check_auth` is contract-agnostic, so this is client-side work only — no contract change is required or possible.

### Acceptance criteria
- [ ] A document states conformance per SEP-43 method, including what is deliberately unsupported
- [ ] The standard surface is implemented once and shared by every caller
- [ ] Tests assert the request and response shapes the standard specifies
- [ ] A reference dApp drives Veil through the standard interface end to end on testnet

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V293 · Contribute a Veil module to Stellar Wallets Kit

**Labels:** help wanted, Stellar Wave, area:sdk, difficulty:advanced, epic:dapps

### Background
Stellar Wallets Kit is how most Stellar dApps offer a wallet chooser. Its `defaultModules()` currently returns fifteen, and a dApp calling it gets every one of them for free. Veil is in none, so a user holding a Veil wallet cannot connect to a dApp that uses the kit — which is most of them.

There is a close precedent. `GhostsigModule` is in `defaultModules()` today, and its own header describes a wallet with no extension and no stored private key, whose signing key comes from a passkey's PRF output, reached by popup and `postMessage`. That is Veil's architecture. The module interface is small:

```ts
export class VeilModule implements ModuleInterface {
  moduleType = ModuleType.HOT_WALLET
  productId; productName; productUrl; productIcon
  isAvailable(): Promise<boolean>
  getAddress(): Promise<{ address: string }>
  signTransaction(xdr, opts): Promise<{ signedTxXdr; signerAddress? }>
  signAuthEntry(authEntry, opts)
}
```

The kit's own note on `defaultModules()` sets the bar: a listed module must need no extra configuration and no polyfills from the dApp.

### What to build
- A `VeilModule` implementing the interface, with tests alongside the ones the other modules ship.
- `isAvailable()` must detect the injected provider from V291 when running inside Veil's browser, and fall back to a popup or deeplink elsewhere — one module covering both, as GHOSTSIG does.
- No configuration and no polyfill required of the dApp, or it cannot be listed in the defaults.
- Open the PR upstream. The module and its tests are the proposal; a working module argues better than a document.

### Acceptance criteria
- [ ] The module implements the full interface and its tests pass in the kit's own suite
- [ ] Works both inside Veil's dApp browser and from an ordinary desktop browser
- [ ] Requires no extra configuration or polyfill from the dApp
- [ ] The upstream PR is opened, and its URL is in this issue
- [ ] A real dApp connects to Veil through the kit, with the transaction hash in the PR

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---
