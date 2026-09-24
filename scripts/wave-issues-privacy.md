# Wave batch 12 — Private payments (DRAFT, not published)

**Source:** `docs/PRIVACY_COST.md` (2026-09-14). **Repo:** `Miracle656/veil`. **IDs:** V131–V149 (batch 11 ended at V130). **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** create the `epic:privacy` label (it does not exist yet). The publish step appends the contributor Telegram footer, as with earlier batches.

## Ground rules shared by every issue in this batch

Put these at the top of each issue's Background, or link to this section:

- **Integrate, don't build.** Veil uses Nethermind/SDF **Stellar Private Payments (SPP)**: npm `stellar-private-payments` (web, WASM) and the Rust SDK in `sdk/native` of `NethermindEth/stellar-private-payments`. No circuits, trusted setup or pool contracts of our own.
- **Canonical pools only, and every address must be traceable to upstream.** Take every contract id from SPP's `deployments/testnet/deployments.json` — never retype one from a doc, a chat message or another issue. Pinning the values into a config module is fine and is what V131 does; what makes it fine is that it names the upstream commit it was pinned from, and a test asserts the values. A Veil-only pool would hide far less.
- **Every address must pass `StrKey.isValidContract` / `StrKey.isValidEd25519PublicKey`.** This gets checked in review. The rule exists because three PRs in this batch shipped invented ids while citing upstream as the source — see `frontend/wallet/lib/privacy/config.ts` for how to do it properly.

  Verified against upstream on 2026-09-24, for reference only — read them from the file, do not paste these:

  | key | id |
  |---|---|
  | `public_key_registry` | `CC6EJCBEULJGHNQQROKLXD6M6IKFW6LN7IHTVUEFQQWZDDLCMNPWXIH4` |
  | `verifiers.B` | `CD34JHLNB7AYASRLOTMT6EECBKFMOS356PPP5RPXRO5Y5EA5Y4DIXGTV` |
  | `verifiers.B_gvk_T` | `CDBA2ZZSVV5VVE4OL2ORCSG2XDN4CD2UPTZIEO7BI32RKRTPFCUF2FMV` |
  | `asp_membership` | `CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGC` |
  | `asp_non_membership` | `CAFLZKGO3KYKNOBPCVT3APFEWMUBRDBF4EVYK65E6O653WYMX4XH4QYJ` |
  | pool 0 (XLM, blocklist) | `CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT` |
  | pool 1 (XLM, blocklist, `gvkMode: traceable`) | `CADS665GRBHOMPE7GY5XYTFT2J5JKRZN6ILYMJ5ZO62GU4YPL3PYIN42` |

  **Both testnet pools are native XLM** (same `tokenContractId`). There is no EURC pool; an earlier version of these rules said there was.
- **Testnet only, behind a flag.** SPP is an unaudited developer preview, "not yet approved for mainnet". Nothing in this batch may enable privacy on mainnet.
- **Keys never leave the device.** No server sees a private key, a note, or the signature the keys are derived from.
- **Fees are sponsored**, like every other Veil transaction. Measured cost: ~0.0174 XLM per private transaction, at most 82.5M of mainnet's 400M instructions.

---

### V131 · Privacy feature flag and SPP network config

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:easy, epic:privacy

### Background
Private payments come from Stellar Private Payments (SPP), which runs on testnet only. Every later issue in this batch needs one switch to hide the feature and one place to read pool and contract IDs.

### What to build
- A `privacy` feature flag, **off by default and forced off on mainnet**, on web and mobile.
- A per-network SPP config: pool IDs, verifier, ASP and public-key-registry contract IDs, and the bootnode URL. Testnet values come from SPP's `deployments/testnet/deployments.json`; mainnet has no entry.

### Key files
- `frontend/wallet/lib/network.ts`, `frontend/mobile/lib/network.ts`
- `frontend/wallet/lib/privacy/config.ts` (new), `frontend/mobile/lib/privacy/config.ts` (new)

### Acceptance criteria
- [ ] Flag off by default; it cannot be turned on while the network is mainnet
- [ ] Testnet config matches SPP's `deployments.json`, with a comment naming the upstream commit
- [ ] Unit tests cover the mainnet lock-out

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V132 · Derive privacy keys from the passkey wallet

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:privacy

### Background
SPP derives a user's note keypair (BN254) and encryption keypair (X25519) from a wallet signature over the fixed message `"Privacy Pool Key Derivation [v1]"` (`sdk/native/src/zk/encryption.rs`). The reference app gets that signature from Freighter's `signMessage`. Veil has no Freighter. It does have a spending key derived from the passkey's PRF, and signing with it is deterministic, so private keys can come back with the passkey.

### What to build
A signer adapter that produces SPP's key-derivation signature with Veil's PRF-derived spending key, on web and mobile, and hands it to SPP's key derivation. The signature is never stored.

### Key files
- `frontend/wallet/lib/feePayer.ts`, `frontend/mobile/lib/deriveFeePayer.ts`
- `frontend/wallet/lib/privacy/keys.ts` (new), `frontend/mobile/lib/privacy/keys.ts` (new)

### Acceptance criteria
- [ ] Same passkey → same privacy public keys on web and mobile (test vector in both suites)
- [ ] Recovering the wallet on a new device restores the same keys
- [ ] A wallet whose passkey has no PRF (e.g. Samsung Pass) is told clearly that private balances cannot be recovered on another device, before it shields anything
- [ ] No key, note or signature is written to logs, analytics or any server

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V133 · Let the RPC proxy serve SPP's calls

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:privacy

### Background
Veil reaches mainnet through `/api/rpc/mainnet`, which forwards only an allow-list of JSON-RPC methods and fails over across providers. SPP's sync and transact paths may call methods outside that list. Privacy is testnet-first, but the proxy must not be the thing that breaks it later.

### What to build
Record every JSON-RPC method the SPP web SDK calls (init, sync, bootnode probe, transact). Extend the allow-list only where needed, with a test per added method. Confirm event scanning works through each public upstream.

### Key files
- `frontend/wallet/app/api/rpc/mainnet/route.ts`
- `frontend/wallet/lib/rpcFailover.ts`, `frontend/wallet/lib/__tests__/rpcFailover.test.ts`

### Acceptance criteria
- [ ] A written list of SPP's RPC methods in the PR description
- [ ] Allow-list updated only as needed, each addition covered by a test
- [ ] No upstream URL or key reaches the browser

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V134 · Web: SPP client wrapper

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:privacy

### Background
SPP's browser SDK (`Client.new({ rpcUrl, storage, proverWorkerUrl, bootnodeUrl })` → `account()` → `pool()`) proves in a WASM worker and stores state in SQLite on OPFS. Veil needs one wrapper that owns that lifecycle, so pages never touch the SDK directly.

### What to build
`lib/privacy/client.ts`: lazy init (the SDK is ~42 MB, so it must not load on pages that don't use it), binds the V132 signer, runs background sync, exposes `privateBalance()`, `shield()`, `privateSend()` and `unshield()`, and turns SDK errors into user-facing messages.

### Key files
- `frontend/wallet/lib/privacy/client.ts` (new)
- `frontend/wallet/next.config.*` (worker and WASM asset serving)

### Acceptance criteria
- [ ] The SDK is loaded only when a privacy screen opens; the main bundle size is unchanged
- [ ] Sync survives a reload without re-deriving keys
- [ ] Errors surface as readable messages, never raw SDK text
- [ ] Apache-2.0 / GPLv3 NOTICE files from SPP's `deployments/legal/dist` are served with the app

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V135 · Web: private balance card and sync status

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:privacy, epic:dashboard

### Background
Shielded money isn't in the normal balance, so users need to see it separately, along with whether the wallet has finished scanning the pool.

### What to build
A "Private" balance card in the Veil brand. It shows the shielded amount per pool asset, masked when hidden amounts is on, and a sync state: syncing / up to date / needs history (bootnode). It is visible only when the V131 flag is on.

### Key files
- `frontend/wallet/app/dashboard/page.tsx`
- `frontend/wallet/components/PrivateBalanceCard.tsx` (new)

### Acceptance criteria
- [ ] Shows the private balance per asset, respecting hidden amounts
- [ ] Sync state is never shown as a confident zero while still scanning
- [ ] Hidden entirely when the flag is off

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V136 · Web: shield (move money into private)

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:privacy

### Background
A shield is SPP's deposit: public funds go into the pool as a private note. It is the first private transaction a user makes.

### What to build
An Amount → Review → Complete flow. The review screen says plainly that the deposit itself is visible on chain, and only what happens inside the pool is private. It uses the V134 wrapper, pays from the spending account, and shows proving progress.

### Key files
- `frontend/wallet/app/privacy/shield/page.tsx` (new)
- `frontend/wallet/lib/privacy/client.ts`

### Acceptance criteria
- [ ] A testnet XLM shield completes, and the private balance updates
- [ ] Review screen states what is and isn't private
- [ ] Proving progress is shown; a cancelled or failed proof leaves no partial state

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V137 · Web: private send

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:privacy, epic:send-receive

### Background
A private send moves value inside the pool: neither the amount nor the recipient appears on chain. The recipient is found through SPP's public-key registry, so they must have registered their privacy keys first.

### What to build
A private send flow: choose a recipient (contact or address) → look them up in the registry → Amount → Review → Complete. If the recipient isn't registered, say so and offer a normal send instead.

### Key files
- `frontend/wallet/app/privacy/send/page.tsx` (new)
- `frontend/wallet/lib/privacy/client.ts`

### Acceptance criteria
- [ ] Two testnet Veil wallets complete a private send; the recipient's private balance increases
- [ ] The explorer entry for the transaction shows neither the amount nor the recipient
- [ ] Unregistered recipient is handled with a clear message and a fallback

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V138 · Web: unshield (move money back out)

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:privacy

### Background
An unshield is SPP's withdraw: a note is spent and public funds go to an account.

### What to build
An Amount → Review → Complete flow that withdraws to the user's own spending account by default, or to another address if they type one. The review screen says the withdrawal is visible on chain.

### Key files
- `frontend/wallet/app/privacy/unshield/page.tsx` (new)

### Acceptance criteria
- [ ] A testnet unshield lands in the spending account, and both balances update
- [ ] Withdrawing more than the private balance is blocked before any proof is made

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V139 · Web: selective disclosure ("prove this payment")

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:privacy

### Background
Privacy that can't be shown to a bank, landlord or tax office is a liability. SPP supports user-initiated, note-scoped disclosure proofs, bound to the party they are for.

### What to build
From a private transaction's detail view, generate a disclosure for one payment and export it as a file or link, plus a verify page that checks one.

### Key files
- `frontend/wallet/app/privacy/disclose/page.tsx` (new)
- `frontend/wallet/app/privacy/verify/page.tsx` (new)

### Acceptance criteria
- [ ] A disclosure reveals exactly one payment, and nothing about the user's other notes
- [ ] The verify page accepts a valid disclosure and rejects a tampered one

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V140 · History for private balances past the 7-day RPC window

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:privacy

### Background
Private notes are found by scanning pool events, and RPC keeps only 7 days of them (`ledgerRetentionWindow` 120960 on the public providers). A user who joins later, or returns after a week, cannot find their notes without a bootnode that holds the full history. SPP's testnet default is Nethermind's `https://bootnode.dev-nethermind.xyz`.

### What to build
Run SPP's bootnode for the canonical pools, as a small standalone service or inside Wraith. Wire it in as the SDK's `bootnodeUrl`, and write down hosting, storage growth and cost.

### Key files
- `wraith/` (if hosted there), or a new `services/spp-bootnode/`
- `frontend/wallet/lib/privacy/config.ts`, `frontend/mobile/lib/privacy/config.ts`

### Acceptance criteria
- [ ] A wallet first opened more than 7 days after its first shield still finds its notes
- [ ] Docs record storage per 10k pool events and the monthly hosting cost
- [ ] The app falls back to Nethermind's bootnode when ours is unreachable, and says so

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V141 · Mobile: prover spike — WebView vs native

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:privacy

### Background
React Native's Hermes engine has no WebAssembly, so SPP's browser prover cannot run as is. There are two options: host the web SDK in a hidden WebView, or wrap the Rust SDK (`sdk/native`: arkworks, parallel proving on native) in a native module. The choice decides a large part of the budget.

### What to build
A throwaway prototype of each that proves one SPP transaction on a low-end Android phone. Measure proof time, peak memory, app size added and battery. Then a short decision doc.

### Key files
- `docs/adr/` (new decision record)
- `frontend/mobile/` (spike branch only)

### Acceptance criteria
- [ ] Proof time and peak memory for both options, measured on a named low-end device
- [ ] App size added by each option
- [ ] A recommendation with its reasoning, in `docs/adr/`

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V142 · Mobile: circuit download, cache and checksum

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:privacy

### Background
Proving needs circuit artifacts: about 12 MB per pool policy (8.1 MB r1cs + 4.1 MB proving key for the block-list pool). They must not ship inside the APK, and a tampered file must never be used.

### What to build
Download on first use, with progress and a Wi-Fi hint, cached on the device and verified against SPP's published checksums (the circuit lockfile) before use. Resumable after a dropped connection.

### Key files
- `frontend/mobile/lib/privacy/circuits.ts` (new)

### Acceptance criteria
- [ ] A checksum mismatch deletes the file and refuses to prove
- [ ] An interrupted download resumes rather than restarting
- [ ] The APK size doesn't change

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V143 · Mobile: SPP state storage

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:privacy

### Background
In the browser, SPP keeps notes and sync state in SQLite on OPFS (`sdk/native/src/state/schema.sql`). Mobile has no OPFS, so the same schema needs a native SQLite home, encrypted, since it holds the user's private notes.

### What to build
A storage adapter for the V141 path that implements SPP's schema on device SQLite, encrypted at rest with a key held in the secure store, and cleared when the wallet is removed.

### Key files
- `frontend/mobile/lib/privacy/storage.ts` (new)
- `frontend/mobile/lib/walletStore.ts`

### Acceptance criteria
- [ ] Notes survive an app restart and sync resumes where it stopped
- [ ] The database is unreadable without the secure-store key
- [ ] Removing the wallet deletes it

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V144 · Mobile: private balance, shield, send and unshield screens

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:privacy

### Background
Mobile is Veil's main product. Once V141–V143 land, it needs the same private flows as web, in the Veil brand (Screen, Card, Button; Lora, Anton, Inter, Inconsolata; gold on near-black).

### What to build
A private balance on the dashboard, plus shield, private send and unshield as Amount → Review → Complete flows. They reuse the V132 keys and the V142 circuits, show proving progress, and stay hidden unless the V131 flag is on.

### Key files
- `frontend/mobile/app/privacy/` (new)
- `frontend/mobile/app/(tabs)/dashboard.tsx`

### Acceptance criteria
- [ ] Testnet shield → private send → unshield completes on a physical Android phone
- [ ] The screens match the brand and the existing flow pattern
- [ ] Amounts are masked when hidden amounts is on

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V145 · Mobile: native prover module (if V141 picks native)

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:privacy

### Background
Only needed if the V141 decision record picks the native path. SPP's Rust SDK proves with arkworks, and parallel proving on native is faster than WASM.

### What to build
A React Native native module (e.g. via uniffi) that exposes SPP's Rust prover and sync to JS, for Android first, with the build wired into EAS.

### Key files
- `frontend/mobile/modules/spp-native/` (new)
- `frontend/mobile/app.config.ts`

### Acceptance criteria
- [ ] Proves the V141 benchmark transaction on the same device, faster than the WebView result
- [ ] Builds in EAS without manual steps
- [ ] A binary without the module still launches, as with the background task

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V146 · Private transaction fees: sponsorship and measurement

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:easy, epic:privacy

### Background
The first estimate (~0.0174 XLM median, 31 testnet transactions) is what the SCF budget rests on. Every private transaction should keep confirming it.

### What to build
Sponsor private transaction fees like other Veil fees. Record fee charged and instructions used for each private transaction, without amounts, keys or addresses, so the figure in `docs/PRIVACY_COST.md` can be refreshed from real use.

### Key files
- `frontend/wallet/lib/privacy/client.ts`
- `docs/PRIVACY_COST.md`

### Acceptance criteria
- [ ] The user never needs XLM for a private transaction beyond what normal sends need
- [ ] The recorded fee and instruction figures contain nothing that identifies a user or amount

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V147 · Threat model for the privacy integration

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:intermediate, epic:privacy

### Background
The Soroban Audit Bank asks for a STRIDE threat model, and so does good sense. Private notes are money: a leak, a bad key derivation or a replayed disclosure are losses.

### What to build
A STRIDE threat model covering key derivation (V132), note storage (V143), circuit artifacts (V142), the bootnode (V140), disclosures (V139), the RPC proxy (V133), and what SPP's own trust assumptions (ASP operator, view keys) mean for Veil users.

### Key files
- `docs/PRIVACY_THREAT_MODEL.md` (new)

### Acceptance criteria
- [ ] Every component above has its threats, mitigations and residual risks listed
- [ ] Each mitigation links the issue or code that implements it

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V148 · End-to-end private payment test on testnet

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate, epic:privacy

### Background
Private flows cross many parts (keys, prover, pool, sync), and each can break the others silently. One round trip that runs on its own catches that.

### What to build
A script and CI job, manual or nightly, that creates two funded testnet wallets and runs shield → private send → unshield through Veil's privacy client, checking balances at each step.

### Key files
- `frontend/wallet/e2e/privacy.spec.ts` (new) or `scripts/privacy-e2e.mjs` (new)
- `.github/workflows/`

### Acceptance criteria
- [ ] The round trip passes on testnet and fails with a clear step name when it breaks
- [ ] Uses Friendbot only; no secrets in the repo

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V149 · User guide: what "private" means in Veil

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:privacy

### Background
Privacy features fail when users think they hide more than they do. SPP hides amounts and counterparties inside the pool. Deposits into and withdrawals out of the pool are public, and the pool has compliance controls (block/allow lists, freeze, disclosure).

### What to build
A short in-app and docs-site explainer: what is hidden, what isn't, why shield and unshield are visible, how disclosure works, and that the pool operator can freeze listed keys. Plain language, no jargon.

### Key files
- `frontend/docs/pages/privacy.mdx` (new)
- In-app link from the V135 card and the V144 screens

### Acceptance criteria
- [ ] States what is and isn't private without overclaiming
- [ ] Linked from every privacy screen

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

## Not contributor issues — maintainer tasks

These come from the same cost breakdown but can't be handed to contributors:

- **Legal review before any mainnet privacy.** `docs/NGN_RAILS.md` records that "just the tech layer" is not a safe position in Nigeria; privacy adds scrutiny. Cost unknown until counsel is asked.
- **Mainnet go/no-go.** Only after SPP is audited and approved for mainnet, on the canonical pool.
- **Bootnode hosting account.** Pay for, and own, whatever V140 runs on.
- **SCF application.** Replace the old fork-and-harden plan with "integrate Stellar Private Payments" and budget ~9–15 engineer-weeks plus bootnode hosting (see `docs/SCF_STRATEGY.md` §6).
- **Audit.** Nothing extra while using the shared pool. If Veil ever deploys pool contracts, route them through the Audit Bank: up to 100% covered, 5% co-pay refunded when findings are fixed within 20 business days.

## Batch totals

19 issues · 3 Easy (300) · 8 Intermediate (1,200) · 8 Advanced (1,600) · **3,100 points**
