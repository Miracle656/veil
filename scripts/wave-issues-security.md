# Wave batch 13 — Security hardening (DRAFT, not published)

**Source:** verification of the 2026-09-17 pre-mainnet audit, re-checked against `origin/main` @ `935dfed` on 2026-09-18. **Repo:** `Miracle656/veil`. **IDs:** V162–V175 (V131–V149 are the privacy batch; V150–V161 are held back — see below). **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** create the `epic:hardening` label (it does not exist yet). The publish step appends the contributor Telegram footer, as with earlier batches.

## What is NOT in this file

Twelve findings from the same review are **deliberately absent**. They describe defects that are exploitable against users on mainnet right now, and this repository is public — filing them here would publish a working recipe before the fix exists. They are drafted, with the same issue format and IDs V150–V161, in the untracked `security-review/` directory, and should be fixed in private branches (or via GitHub private security advisories) and only then, if at all, opened as public issues.

Everything below is safe to publish: it is defence-in-depth, dependency currency, CI supply chain, and correctness work that does not hand anyone an attack.

## Ground rules shared by every issue in this batch

- **No behaviour changes beyond the stated fix.** These are security issues; a PR that also reformats the surrounding file is much harder to review and will be sent back. (This has been a recurring pattern in past waves.)
- **Every fix needs a test that fails before it and passes after**, unless the issue says otherwise (pure config changes are exempt).
- **Do not upgrade unrelated dependencies** in the same PR.
- Contract changes cannot ship alone: the factory and wallet contracts are **not upgradeable**, so anything under `contracts/` lands in the contracts-v2 batch and is deployed once, to new addresses.

---

### V162 · Scope EXPO_TOKEN to the one step that needs it

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy, epic:hardening

### Background
`EXPO_TOKEN` unlocks the Android signing keystore. In `.github/workflows/mobile-apk.yml` it is declared as job-level `env`, so every step can read it — including dependency installation, which runs third-party lifecycle scripts. A stolen keystore is unusually bad here: an APK signed with our key matches `assetlinks.json`, so the attacker's app would be trusted for passkeys on `app.useveilapp.xyz`.

### What to build
- Move `EXPO_TOKEN` off the job and onto only the steps that need it (the EAS build step, and the token check).
- Install dependencies with `npm ci --ignore-scripts` where the build still succeeds; if a package genuinely needs its install script, say which in the PR.
- Pin `eas-cli` to an exact version instead of `@latest`.

### Key files
- `.github/workflows/mobile-apk.yml`

### Acceptance criteria
- [ ] No job-level `EXPO_TOKEN`
- [ ] `eas-cli` pinned to an exact version
- [ ] A dispatched build still produces an APK whose certificate matches `assetlinks.json` (the existing verify step proves this)

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V163 · Pin every GitHub Action to a commit SHA

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy, epic:hardening

### Background
Every workflow references actions by moving tag (`actions/checkout@v4`). A tag can be repointed by whoever controls the action's repository, so a compromised upstream reaches our runners — which hold the Expo token, npm credentials and `contents: write`.

### What to build
- Replace every `uses:` tag with the full 40-character commit SHA, keeping the human-readable version in a trailing comment (`# v4.2.2`).
- Cover all workflows in `.github/workflows/`.

### Key files
- `.github/workflows/*.yml`

### Acceptance criteria
- [ ] No `uses:` line references a tag or branch
- [ ] Each pinned line carries a comment naming the version it pins
- [ ] Workflows still pass on a test run

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V164 · Give every workflow an explicit top-level `permissions:`

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy, epic:hardening

### Background
Six workflows declare no `permissions:` block, so they inherit the repository default token scope — broader than any of them needs. The principle is that a workflow's token should be able to do exactly what that workflow does and nothing else.

### What to build
- Add a top-level `permissions:` to every workflow that lacks one, starting from `contents: read` and adding only what the workflow demonstrably needs.
- Where a single job needs more (for example publishing), scope the wider permission to that job rather than the file.

### Key files
- `.github/workflows/*.yml`

### Acceptance criteria
- [ ] Every workflow file has a top-level `permissions:`
- [ ] None grants `write` it does not use
- [ ] All workflows still pass

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V165 · Stop piping remote scripts into a shell in CI

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate, epic:hardening

### Background
`testnet-smoke.yml` and `mobile-e2e.yml` install tools with `curl … | bash` from moving branches. Whatever that URL serves at the moment the job runs is executed with the job's token in scope, and nothing verifies it is what we expected.

### What to build
- Replace each `curl | bash` with a pinned release artifact plus a checksum check, or an official pinned action.
- If a tool only ships an install script, download it, verify a recorded SHA-256, then run it.

### Key files
- `.github/workflows/testnet-smoke.yml`, `.github/workflows/mobile-e2e.yml`

### Acceptance criteria
- [ ] No `curl … | bash` or `wget … | sh` in any workflow
- [ ] Every downloaded artifact is checksum-verified against a committed value
- [ ] Both workflows still pass

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V166 · Bring `next` to a patched release across all three apps

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:easy, epic:hardening

### Background
`frontend/wallet`'s lockfile resolves `next@16.2.10`. The middleware-authorisation-bypass fix landed in 16.2.11, and the image-optimizer advisories are fixed in the 16.3 line. The website and docs apps need the same treatment.

### What to build
- Raise `next` to a patched release in the wallet, website and docs apps, and refresh each lockfile.
- Check the release notes for breaking changes between the current and target minor, and fix any fallout.

### Key files
- `frontend/wallet/package.json`, `frontend/website/package.json`, `frontend/docs/package.json` and their lockfiles

### Acceptance criteria
- [ ] No app resolves a `next` version with an open advisory
- [ ] `npm run build` passes in each app
- [ ] Existing tests pass; no unrelated dependency changes in the diff

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V167 · Migrate WalletConnect to `@reown/walletkit`

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:advanced, epic:hardening

### Background
`@walletconnect/web3wallet` is deprecated and pulls in a transitive `elliptic` with a key-extraction advisory, plus several WalletConnect core/utils advisories. It is used by both the web wallet and mobile. The maintained replacement is `@reown/walletkit`.

### What to build
- Replace `@walletconnect/web3wallet` with `@reown/walletkit` on web and mobile, following the upstream migration guide.
- Keep the existing pairing, session and approval behaviour identical; this is a dependency migration, not a redesign.

### Key files
- `frontend/wallet/lib/walletConnect.ts`, `frontend/mobile/lib/walletConnect.ts`, both `package.json`s

### Acceptance criteria
- [ ] `@walletconnect/web3wallet` gone from both lockfiles, advisories cleared
- [ ] Pair, approve a session, sign a transaction and disconnect all still work on testnet — describe your manual test in the PR
- [ ] Existing WalletConnect tests pass

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V168 · Decode every operation in the WalletConnect approval modal

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:hardening

### Background
`WalletConnectApprovalModal` reads `tx.operations?.[0]` and shows that one operation. A dApp request containing several operations is approved with only the first shown, so the user consents to something they were never told about. An approval screen that shows less than the transaction does is worse than no approval screen, because it creates false confidence.

### What to build
- Decode and display **every** operation: type, destination, asset and amount, and for `invokeHostFunction` the contract, function and arguments.
- Show sub-invocations from the auth entries too, not just the top-level call.
- Make it clear in the UI when a transaction contains more than one operation.

### Key files
- `frontend/wallet/components/WalletConnectApprovalModal.tsx`, `frontend/mobile/components/WalletConnectApprovalModal.tsx`

### Acceptance criteria
- [ ] A multi-operation transaction lists all operations
- [ ] Contract calls show contract, function and decoded arguments
- [ ] Unit tests cover a multi-op transaction and a contract call with sub-invocations

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V169 · Remove testnet defaults from mainnet code paths

**Labels:** help wanted, Stellar Wave, area:mobile, area:wallet, difficulty:easy, epic:hardening

### Background
Several modules fall back to testnet values when configuration is missing, on paths that also run on mainnet: `frontend/mobile/app/buy.tsx:29`, `frontend/mobile/app/withdraw.tsx:37`, `frontend/wallet/lib/backup.ts:56,150`. A silent testnet default on a mainnet screen is a class of bug that produces confidently wrong results rather than an error.

### What to build
- Replace each testnet default with a value read from the active network config.
- Where no value is configured for the active network, fail loudly with a clear message instead of guessing.

### Key files
- `frontend/mobile/app/buy.tsx`, `frontend/mobile/app/withdraw.tsx`, `frontend/wallet/lib/backup.ts`

### Acceptance criteria
- [ ] No hard-coded testnet passphrase, asset issuer or contract id on a shared path
- [ ] Missing mainnet config produces a clear error, not a testnet fallback
- [ ] Tests cover the mainnet path for each file changed

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V170 · Carry the asset issuer and memo through deep links and QR

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:hardening

### Background
`lib/deepLinks.ts` drops `asset_issuer`, so a link naming "USDC" resolves to whatever USDC the wallet happens to hold — and anyone can issue an asset called USDC. The QR scanner drops the memo, which is how exchange deposits are credited; a deposit sent without its memo is typically lost.

### What to build
- Parse and carry `asset_issuer` through deep links, and match the asset on code **and** issuer.
- Carry the memo from scanned SEP-7 URIs into the send flow and show it on the confirmation screen.
- When a link names an asset the wallet cannot resolve to a specific issuer, say so rather than picking one.

### Key files
- `frontend/wallet/lib/deepLinks.ts`, `frontend/mobile/lib/deepLinks.ts`, the QR scanner components

### Acceptance criteria
- [ ] Asset resolution requires code + issuer
- [ ] Memo survives scan → review → submit
- [ ] Tests cover a link with an unknown issuer and a URI carrying a memo

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V171 · Tighten the wallet CSP and add headers to website and docs

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:hardening

### Background
The wallet's CSP allows `'unsafe-inline'` and `'unsafe-eval'` and opens `connect-src` to all of `https:` and `wss:`, which removes most of the protection a CSP provides. The website and docs apps send no security headers at all.

### What to build
- Remove `'unsafe-eval'`, and replace `'unsafe-inline'` with nonces or hashes for the scripts that need it.
- Narrow `connect-src` to the endpoints the wallet actually uses (RPC, Horizon, Wraith, the agent).
- Add a baseline header set to the website and docs apps: CSP, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors`.

### Key files
- `frontend/wallet/next.config.js`, `frontend/website/next.config.js`, `frontend/docs/next.config.js`

### Acceptance criteria
- [ ] Wallet CSP has no `unsafe-eval`, and `connect-src` is an explicit list
- [ ] No CSP violations in the console across dashboard, send, receive, swap and agent
- [ ] Website and docs send the baseline headers

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V172 · Require a secure WebSocket for the agent outside development

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:easy, epic:hardening

### Background
Both wallets default the agent connection to `ws://localhost:3001` and never require `wss://` in production. A plaintext WebSocket carrying transaction XDR is readable and modifiable by anything on the path.

### What to build
- Require `wss://` whenever the app is not running against localhost, and refuse to connect otherwise with a clear message.
- Keep `ws://localhost` working for development.

### Key files
- `frontend/wallet/lib/agent*.ts`, `frontend/mobile/lib/agent*.ts`

### Acceptance criteria
- [ ] A non-localhost `ws://` URL is refused
- [ ] Localhost development is unaffected
- [ ] Unit tests cover both cases

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V173 · Bound the agent's WebSocket resources

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:intermediate, epic:hardening

### Background
The agent server sets no `maxPayload`, so the `ws` default of 100 MiB applies per message; there is no cap on concurrent connections; and the rate limit is per socket, so it resets when a client reconnects. Any one of these lets a single client exhaust the server.

### What to build
- Set a `maxPayload` appropriate to the largest legitimate message.
- Cap concurrent connections, and cap connections per remote address.
- Key the rate limit on something that survives reconnection rather than on the socket.
- Stop returning raw `err.message` to clients (`server.ts:180`); log the detail, return something generic.

### Key files
- `packages/agent/src/server.ts`

### Acceptance criteria
- [ ] Oversized messages are rejected without allocating the payload
- [ ] Connection caps enforced, with a test
- [ ] Rate limit survives reconnection, with a test
- [ ] No internal error text reaches a client

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V174 · Label the example apps, or fix them

**Labels:** help wanted, Stellar Wave, area:examples, difficulty:easy, epic:hardening

### Background
People copy examples into production. Several of ours demonstrate patterns that are unsafe outside a demo: `subscription-paywall` grants access to whoever sets a cookie naming a subscriber address; `qr-pos` settles any payment of a matching amount when the memo check is off and generates memos with `Math.random`; `discord-faucet` keeps its cooldown in memory with no per-destination cap; `tauri` and `capacitor` store raw or extractable private keys; `electron` keeps a signer secret in `localStorage`.

### What to build
- Add a prominent "demonstration only — not production-safe" banner to each affected example's README **and** its UI, naming the specific shortcut it takes.
- Where the safe version is only a few lines away (a per-destination cap in the faucet, a crypto-random memo in `qr-pos`), fix it instead of labelling it.

### Key files
- `examples/*/README.md` and the entry point of each affected example

### Acceptance criteria
- [ ] Every example listed above carries a specific warning, not a generic one
- [ ] `qr-pos` uses a cryptographically random memo
- [ ] `discord-faucet` has a per-destination and a global cap

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V175 · Make the reproducible build genuinely independent

**Labels:** help wanted, Stellar Wave, area:contracts, area:ci, difficulty:intermediate, epic:hardening

### Background
The reproducible-build workflow references its container by tag rather than digest, and the second build reuses the first build's `target/` directory — so it does not prove what an independent rebuild would prove. This matters beyond security: byte-for-byte reproducibility against mainnet is part of the SCF application.

### What to build
- Pin the build image by digest.
- Make the verification build start from a clean checkout and an empty `target/`.
- Record the resulting WASM hashes in the job summary so a reviewer can compare without downloading anything.

### Key files
- `.github/workflows/reproducible-build.yml`

### Acceptance criteria
- [ ] Image pinned by `@sha256:…`
- [ ] Second build shares no state with the first
- [ ] Hashes printed in the summary and matching `contracts/expected-hashes.json`

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

## Owner tasks — not contributor issues

These are repository and account settings. They need an admin, take minutes, and should not wait for a wave.

1. **Populate the `veilruleset` target refs.** The ruleset is `enforcement: active` with deletion, non-fast-forward and PR rules, but `conditions.ref_name.include` and `.exclude` are both empty, so it applies to no branch. `main` reports `protected: false`. Toggling enforcement will look like a fix and will not be one.
2. **Replace the `SECURITY.md` contact.** `security@invisible-wallet.dev` is NXDOMAIN — the domain is unregistered, so anyone may register it and start receiving our vulnerability reports. Move to an address on a domain we own and enable GitHub private vulnerability reporting.
3. **Publish a disclosure runbook** in `SECURITY.md`: who is contacted, expected response time, and what happens on key compromise. The version table is also stale (npm ships 0.2.0).
