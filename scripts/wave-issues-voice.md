# Wave batch 19 — voice assistants, read-only first (DRAFT)

**Repo:** `Miracle656/veil`. **IDs:** V241–V247. **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** create the `epic:voice` label.

## Why this batch is deliberately small

"Hey Siri, send Tunde 5,000" is the obvious demo and the wrong place to start. Everything that **reads** is safe, ships on iOS today, and is genuinely differentiating. Everything that **moves money** is gated behind three things Veil does not control: an Apple *organization* enrolment requirement for self-custody wallets, Apple's classification of crypto as a highly regulated field, and an Android API still in private preview.

So this batch ships the read-only surface properly, proves the boundary with a test, and spends one issue researching the payment side rather than guessing at it.

## Shared with every issue

### Platform facts, verified 2026-09-24

| Platform | What exists now |
|---|---|
| **iOS** | **App Intents** + assistant schemas. 100+ actions across twelve domains; conformance is a Swift macro on an `AppIntent`. This is the mature path. |
| **Android** | **AppFunctions** (Android 16+, Jetpack), where an app acts as an on-device MCP server that Gemini calls. **The Gemini integration is private preview with trusted testers**, so it cannot be shipped yet. App Actions, which older guides recommend, is superseded. |
| **Bixby** | Rebuilt on LLMs in One UI 8.5 with Perplexity integration, but there is no visible Capsule developer push. Out of scope for this batch. |

### The security boundary, and the API that enforces it

Voice is a terrible authorisation channel: anyone near the phone can say the words, and voices clone. The sanctioned pattern is **the assistant carries intent, the device authorises**.

Apple ships this as `IntentAuthenticationPolicy` — `.requiresAuthentication` and `.requiresLocalDeviceAuthentication` — plus `requestConfirmation(...)`, and Apple's own guidance names payments as a case for it.

Veil is well placed here because signing already runs through a WebAuthn passkey ceremony into `__check_auth`, which is a user-presence gesture that cannot happen from voice alone. **Nothing in this batch may weaken that.** No intent may sign, hold key material, or reach `signXdrPayload()`.

### The build constraint

`frontend/mobile` is a **managed Expo app** — there is no `ios/` or `android/` directory. App Intents are native Swift, so they arrive through an **Expo config plugin**, the same way `react-native-passkeys` and `expo-secure-store` already do (see the `plugins` array in `app.config.ts`). Expo Go cannot load them; testing needs a dev build.

### Ground rules

- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.
- No intent may speak, log or return a private key, a seed, a passkey credential or a fee-payer secret.
- No secrets in committed files; never render or log an RPC URL.
- Mobile installs with plain `npm install`, never `--legacy-peer-deps`, and tests with jest via `jest-expo`.

---

### V241 · iOS: read-only balance and price as App Intents

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:voice

### Background
The first voice surface should be the one that cannot lose anyone money: "what's my balance", "what's XLM worth". No authorisation, no regulated surface, and it works on iOS today.

### What to build
- An Expo config plugin adding an App Intents extension, following the pattern of the existing native plugins in `app.config.ts`.
- Two intents: current wallet balance, and the price of a named asset.
- Both resolve assets **by issuer** through the existing registry — "what's my USDT0 worth" must not answer for an impostor issuer. Eight issuers publish that code on mainnet.
- Both read through the app's existing balance and price paths. No second data path, no new network client.
- Neither intent is allowed to write anything.

### Acceptance criteria
- [ ] Both intents answer correctly on a dev build, on device
- [ ] Assets resolve by issuer; an unregistered issuer is reported as unverified rather than named as the asset
- [ ] Neither intent can be made to sign, or to return key material, by any input
- [ ] A wallet with no balance answers cleanly rather than erroring
- [ ] Tests cover the resolution logic; the PR states what was verified by hand on device

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V242 · Teach Siri the phrases, including the ones your users actually say

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:voice

### Background
An intent nobody can trigger is not a feature. Siri learns phrases from `AppShortcutsProvider` and from donated shortcuts, and the phrase list is part of the product.

Veil's users are substantially Nigerian, and the OS assistants' support for Nigerian English, Pidgin, Yoruba and Hausa is weak. That is a gap in our favour: the assistant only has to recognise the phrase, and the app does the rest.

### What to build
- An `AppShortcutsProvider` with several natural phrasings per intent, not one canonical sentence.
- Include the phrasings real users produce — "how much I get", "wetin be my balance" — alongside standard English, where the recogniser can handle them.
- A short written note on which phrasings were tested and which the recogniser failed, so the next person does not re-run the same experiment.

### Acceptance criteria
- [ ] At least four phrasings per intent, triggering reliably on a dev build
- [ ] Non-standard phrasings are tested and the results recorded honestly, including failures
- [ ] The app name is not required mid-sentence for the common phrasings
- [ ] No phrase implies the wallet can send money by voice

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V243 · Android: ship App Shortcuts now, structured for AppFunctions later

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:voice

### Background
AppFunctions is the right Android target and **it is not available** — the Gemini integration is private preview for trusted testers. Building against it now means building against something we cannot test or ship.

What does work today is Android App Shortcuts, which surface the same actions to the launcher and to Assistant, and which cost little.

### What to build
- The same read-only actions as V241, exposed as Android App Shortcuts through a config plugin.
- Put the action logic behind one shared, platform-neutral module, so that when AppFunctions opens up, the adapter is the only new code.
- A short note in the module saying what an AppFunctions adapter would need, so the next person starts from the shape rather than the research.

### Acceptance criteria
- [ ] Balance and price reachable from the launcher on a dev build
- [ ] The action logic is shared with iOS, not duplicated
- [ ] No Android-only data path
- [ ] The PR states plainly that AppFunctions is not wired, and why

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V244 · Voice must respect hidden amounts

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:voice

### Background
Veil already lets a user hide amounts on screen — `lib/hiddenAmounts.ts`, with tests, and `lib/notificationPrefs.ts` already honours it for notifications. A voice assistant that answers "you have 412 dollars" out loud in a shared space defeats that, and does it more loudly than a screen ever could.

This is the feature that makes voice trustworthy rather than a liability.

### What to build
- Every spoken response honours the hidden-amounts setting, using the same helper the screens and notifications use.
- When amounts are hidden, the assistant confirms it can answer but declines to say the number aloud, and directs the user to the app.
- The same rule applies to any spoken output, not just the balance intent.

### Acceptance criteria
- [ ] With amounts hidden, no intent speaks a number
- [ ] The response is useful rather than an error — the user learns where to look
- [ ] The setting is read live, not captured when the intent was registered
- [ ] Tests cover both states for every intent that can speak a value

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V245 · Prove that no voice path can sign

**Labels:** help wanted, Stellar Wave, area:mobile, area:testing, difficulty:intermediate, epic:voice

### Background
The read-only boundary is the whole safety argument for this batch, and right now it is a convention. Conventions erode: someone adds a convenience intent, reuses a helper that happens to reach the signer, and the boundary is gone with no test failing.

### What to build
- A test that enumerates every registered intent and asserts none of them can reach `signXdrPayload()`, `registerAuthEntrySigner()`, the wallet store's secret accessors, or any network write.
- Assert it structurally — by the import graph or an explicit allow-list of what an intent may call — not by checking behaviour one intent at a time.
- It must fail if someone adds a new intent that crosses the line, without that person having to remember this test exists.

### Acceptance criteria
- [ ] Adding a signing call to any intent turns the test red — prove it by doing so, and record the result in the PR
- [ ] Adding a *new* intent that signs also turns it red, with no edit to the test
- [ ] The failure message explains the rule, so the next person understands why rather than deleting the assertion
- [ ] It runs in CI

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V246 · Spike: what would AP2 mandates require of Veil?

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:voice

### Background
While voice payments look blocked, the industry standardised the authorisation layer underneath them. **AP2 (Agent Payments Protocol)** was announced by Google in September 2025 and its governance moved to the **FIDO Alliance**, developed in its Agentic Authentication and Payments working groups. Its core primitive is a **Mandate**: a cryptographically signed credential proving a specific human authorised a specific transaction, carrying spending limits, allowed merchants and a validity period. There is an **x402 extension** for stablecoin settlement.

Two pieces already exist in this project. Lens runs an x402 facilitator, and Veil's authorisation is already a FIDO credential. Whether those connect to AP2 as cleanly as that sounds is exactly what this spike is for — **AP2's published documentation mentions x402 but says nothing about WebAuthn or passkeys**, so do not assume the link.

This is a research issue. The deliverable is a decision document, not code.

### What to build
- Read the AP2 specification and establish, concretely: what a Mandate contains, how it is signed and verified, and whether a FIDO/WebAuthn credential can produce or attest one.
- Establish how the x402 extension settles, and whether Lens's existing facilitator is on that path or beside it.
- Answer whether Veil's existing passkey → `__check_auth` ceremony can serve as the human-authorisation step, or whether AP2 expects a separate credential.
- Write it up as an ADR with a recommendation: adopt, wait, or ignore — and say what would change your mind.

### Acceptance criteria
- [ ] Every claim cites the specification, with a link and a section — no summarising from blog posts
- [ ] The document is explicit about what is specified versus what is plausible
- [ ] Lens's facilitator is assessed against the extension, concretely
- [ ] A dated recommendation with its reasoning, so it can be re-read when the ground shifts
- [ ] Spending limits and validity are covered — a mandate is a standing authorisation, and that is the risky part

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V247 · Write down what the voice surface will never do

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:easy, epic:voice

### Background
Once a wallet talks, users form beliefs about what it can do. If the boundary is only in our heads, someone eventually ships "send by voice" as a small convenience and nobody notices what changed.

There is also a commercial edge: Apple requires **organization** enrolment for self-custody wallets, and classifies crypto as a highly regulated field. Anyone planning voice payments needs those facts up front rather than at submission.

### What to build
- A short page covering: what the voice surface does, what it will never do without an on-device authorisation, and why voice alone cannot authorise a payment.
- The store and enrolment constraints, so a future contributor does not design past them.
- Link it from the docs site and from the settings screen where voice is enabled.

### Acceptance criteria
- [ ] States plainly that voice never signs, and what does
- [ ] Records the organization-enrolment and regulated-field constraints, dated
- [ ] Reachable from the app, not only the docs site
- [ ] No claim about what a future version will support

> **Drips Wave** · Complexity: **Easy** · **100 points**
