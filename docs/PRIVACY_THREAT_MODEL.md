# Privacy integration — STRIDE threat model

**Status:** Draft · **Scope:** the Veil/Stellar Private Payments (SPP) integration · **Owner:** privacy wave (V131–V149)
**Read alongside:** `docs/PRIVACY_COST.md` (costs, "integrate don't build"), `docs/adr/0003-fee-payer-key-from-webauthn-prf.md` (key derivation), the issue batch in `scripts/wave-issues-privacy.md`.

**Reference conventions.** V-numbers point at the privacy wave issue definitions in [scripts/wave-issues-privacy.md](../scripts/wave-issues-privacy.md). Code references are `path:line` into this repo; `sdk/native/…` paths are upstream SPP code ([NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments)). Once the wave is published, repoint the V-number links at the GitHub issue URLs.

---

## 1. Scope

The model covers what Veil actually owns or decides in the SPP integration, plus the SPP-side trust the whole feature is built on:

| Component | What it is | Wave issue |
|---|---|---|
| Key derivation | Privacy keys from the passkey wallet | [V132](../scripts/wave-issues-privacy.md#v132--derive-privacy-keys-from-the-passkey-wallet) |
| Note storage | Where notes and sync state live on device | [V143](../scripts/wave-issues-privacy.md#v143--mobile-spp-state-storage) |
| Circuit artifacts | Download, cache, checksum of proving keys | [V142](../scripts/wave-issues-privacy.md#v142--mobile-circuit-download-cache-and-checksum) |
| Bootnode | Full-history event server for note discovery | [V140](../scripts/wave-issues-privacy.md#v140--history-for-private-balances-past-the-7-day-rpc-window) |
| Selective disclosure | "Prove this payment" proofs | [V139](../scripts/wave-issues-privacy.md#v139--web-selective-disclosure-prove-this-payment) |
| RPC proxy | Allow-listed mainnet JSON-RPC relay | [V133](../scripts/wave-issues-privacy.md#v133--let-the-rpc-proxy-serve-spps-calls) |
| SPP trust assumptions | ASP operator, view keys, unaudited code | [V131](../scripts/wave-issues-privacy.md#v131--privacy-feature-flag-and-spp-network-config), ground rules |

Out of scope by design: the SPP contracts, circuits and trusted setup themselves (Veil runs none of them — [ground rules, `scripts/wave-issues-privacy.md`](../scripts/wave-issues-privacy.md)), and the pool's compliance role, which stays with the canonical-pool operator.

## 2. Assets

1. **Privacy keys** — note keypair (BN254) and encryption keypair (X25519). Whoever holds them can spend the user's notes and read their encrypted note metadata. Derived, never stored.
2. **Private notes** — on-chain commitments plus local note state. A note's secret is spendable value; its metadata (when shielded, to whom) is the user's financial privacy.
3. **Note metadata / privacy history** — shielded balances, transaction detail. The asset disclosures are meant to prove.
4. **Disclosure proofs** — verifiable statements about one payment.
5. **Availability of privacy flows** — shield / private send / unshield must not silently break (a wallet that cannot find its notes reads as a confident zero).

## 3. Attacker model and trust boundaries

**Attacker capabilities.** Remote attacker able to intercept network traffic and host malicious services (rogue bootnode, compromised RPC provider, MITM on circuit download). Local attacker with read access to the device (same-origin JS in app/service worker, device malware, forensic access). Social attacker with access to exported disclosures. State/compliance actors with the pool operator's power (block/allow list, freeze, view keys).

**What is NOT in the attacker's hands.** The passkey's private key (non-exportable, hardware-backed; `security.mdx` §1). The WebAuthn PRF output, which only the authenticator can produce.

**Trust boundaries**

| Boundary | Crosses | Controls |
|---|---|---|
| App → RPC proxy (web) | JSON-RPC method + params | Allow-list, server-side URL secrecy (`frontend/wallet/lib/rpcAllowlist.ts:10`, `:40`) |
| App → testnet RPC / bootnode | pool event scans, proof submission | Testnet-only, V131 flag; bootnode direct HTTPS ([`route.ts:40`](../frontend/wallet/app/api/rpc/mainnet/route.ts)) |
| App → circuit host | ~12 MB artifacts per pool | Checked against SPP lockfile (V142); TLS |
| Device storage (web OPFS / mobile SQLite) | notes + sync state | V143 at-rest encryption (mobile); web OPFS is plaintext until wired to PRF cipher |
| App → SPP pool contracts | shield/send/unshield, disclosures | Canonical deployments (V131); verified SPP contracts |
| Pool operator (ASP, view keys) → pool | allow/block lists, freeze, view-key decrypt | Out of Veil control; governed by canonical-pool deal |

## 4. Key derivation (V132)

SPP derives the note keypair (BN254) and encryption keypair (X25519) from a wallet signature over the fixed message `"Privacy Pool Key Derivation [v1]"` (`sdk/native/src/zk/encryption.rs`). The reference app signs with Freighter's `signMessage`; Veil signs with its PRF-derived spending key. The privacy keys are the root of every other asset on the list, and they are *the same on every device* for a given passkey — so a leak or a drift is permanent, not per-device.

| STRIDE | Threat | Impact | Mitigation | Residual |
|---|---|---|---|---|
| S | Attacker reconstructs privacy keys from a non-secret seed. Veil's legacy fee-payer derivation is `HKDF(credentialId)` and the credential ID is public ([ADR 0003 §C2](adr/0003-fee-payer-key-from-webauthn-prf.md)) — if the KDF signature used that key, privacy keys would be derivable by anyone who saw the ID | Total loss of private funds | V132 signs only with the **PRF-derived** key — passkey-bound, unavailable without a real biometric assertion ([V132](../scripts/wave-issues-privacy.md#v132--derive-privacy-keys-from-the-passkey-wallet)); the web accessor pins mode and holds the seed in memory/session only, `sessionStorage` for the live session, never `localStorage` ([`frontend/wallet/lib/feePayer.ts:269`](../frontend/wallet/lib/feePayer.ts), `:347`); mobile holds it in the keychain ([`frontend/mobile/lib/storage.ts:16`](../frontend/mobile/lib/storage.ts)). The legacy credential-ID path is banned for privacy flows — `deriveFeePayerKeypair(credentialId)` carries an explicit SECURITY note ruling it out for passkey-bound use ([`frontend/mobile/lib/deriveFeePayer.ts:12`](../frontend/mobile/lib/deriveFeePayer.ts)) | A compromised device during a signing ceremony can scrape the derived key from memory. Nothing at rest, but nothing stops a live compromise |
| S / T | Derivation drift between web and mobile produces *different* privacy keys from the same passkey → the user's wallet no longer matches their on-chain notes | Private notes permanently unspendable | V132 acceptance: same passkey → same privacy public keys on web and mobile, pinned by test vectors in both suites, and recovery reproduces the same keys. The fee-payer precedent is byte-identical derivation across platforms verified against a golden address ([`frontend/mobile/lib/deriveFeePayer.ts:20`](../frontend/mobile/lib/deriveFeePayer.ts)) | None once the vectors are pinned; the risk is purely in the implementation window before V132 lands |
| I | The KDF signature (or the derived keys) leaked into logs, analytics or a server → passive theft later | Total loss of private funds | V132 acceptance: no key, note or signature written to logs, analytics or any server. PRF output is derived inside the WebAuthn ceremony and consumed immediately ([`sdk/src/crypto/prf.ts:221`](../sdk/src/crypto/prf.ts)) | Log-free is a code-review property, not a mechanism; a future `console.log` reintroduces it |
| D | Passkey without PRF (e.g. Samsung Pass): user shields, then moves to a new device and cannot reproduce the keys → notes exist forever on the old device | Private balance unrecoverable after device loss | V132 acceptance: a wallet whose passkey has no PRF is told clearly that private balances can't be recovered on another device, **before** it shields anything — fail loud, not silent | The loss remains possible, only the surprise is removed. Same gap as `docs/CONTRACTS_V2.md` §8 |

**Deeper mitigation notes.** The PRF salt is domain-separated from every other PRF use (`FEE_PAYER_PRF_SALT`, [`sdk/src/crypto/prf.ts:184`](../sdk/src/crypto/prf.ts)), so the privacy keys cannot collide with the app's local-encryption key from the same passkey. The fee-payer derivation itself is the reference: `evaluateFeePayerPrf` → `deriveFeePayerSeedFromPrf` ([`sdk/src/crypto/prf.ts:221`](../sdk/src/crypto/prf.ts), `:197`), pinned per wallet by `ensureFeePayer` ([`frontend/wallet/lib/feePayer.ts:181`](../frontend/wallet/lib/feePayer.ts)).

## 5. Note storage (V143)

SPP keeps notes and sync state in SQLite inside the app. On web that is OPFS (`sdk/native/src/state/schema.sql`); mobile has no OPFS, so [V143](../scripts/wave-issues-privacy.md#v143--mobile-spp-state-storage) gives the same schema a native SQLite home, encrypted at rest with a key in the secure store, deleted on wallet removal. The notes *are* the privacy balance: whoever reads the DB learns shielded amounts and the user's full private history.

| STRIDE | Threat | Impact | Mitigation | Residual |
|---|---|---|---|---|
| I | Attacker with device/file access reads the note database | Full private history + spendable note secrets exposed | Mobile: at-rest encryption with a key that lives only in the OS keychain — the same wrapper all wallet secrets already route through ([`frontend/mobile/lib/storage.ts:16`](../frontend/mobile/lib/storage.ts), `:24`); key material never reaches AsyncStorage | Keychain-backed encryption inherits the platform's compromise model (rooted/jailbroken device, keylogger) |
| I | Web note DB is plaintext OPFS | Private history readable by any same-origin attacker (XSS, service-worker bug) | Ground rule "keys never leave the device" plus apply the existing passkey-bound AES-GCM cipher ([`createLocalCipher`, `sdk/src/crypto/prf.ts:287`](../sdk/src/crypto/prf.ts)) to OPFS contents as the web baseline. **Not yet wired** — this is the biggest open item for web (§12) | Until wired, web note storage is only as safe as the browser profile's filesystem sandbox |
| T | Attacker edits the sync-state DB (tampered nullifiers / wrong sync cursor) | Notes become unspendable, or re-sync spends the same note twice | [V143](../scripts/wave-issues-privacy.md#v143--mobile-spp-state-storage) stores encrypted with an authenticated cipher, accepting only its own schema, and accepting interruption without partial writes | Deleting the whole DB remains indistinguishable from a fresh install |
| D | Corrupt/partial DB after a crash or interrupted sync | Wallet can't find notes → shows a confident zero | V143 acceptance: notes survive restart and sync resumes where it stopped; web sync survives reload without re-deriving keys ([V134](../scripts/wave-issues-privacy.md#v134--web-spp-client-wrapper)) | Detection (a false zero) needs the sync-state UI; the model relies on that card never reporting "up to date" while a scan is incomplete ([V135](../scripts/wave-issues-privacy.md#v135--web-private-balance-card-and-sync-status)) |
| S | Reset/removal leaves the note DB behind | Old device retains spendable private state after wallet removal | V143 acceptance: removing the wallet deletes the DB — extending the existing per-network wipe ([`clearWalletStore`, `frontend/mobile/lib/walletStore.ts:114`](../frontend/mobile/lib/walletStore.ts)) so it also clears SPP state | Only the claimed wipe path is covered; a full device forensic copy predates the wipe |
| T | Cross-network collision: testnet notes read as mainnet state | Private balance mis-attributed across networks | SPP state takes the same per-network namespacing as the wallet ([`frontend/mobile/lib/walletStore.ts:20`](../frontend/mobile/lib/walletStore.ts), [`frontend/wallet/lib/walletStorage.ts:77`](../frontend/wallet/lib/walletStorage.ts)) | — |

## 6. Circuit artifacts (V142)

Proving needs ~12 MB of artifacts per pool policy (8.1 MB r1cs + 4.1 MB proving key) — `docs/PRIVACY_COST.md` §2. They are downloaded on first use. A tampered proving key is the worst kind of supply-chain break: it can let the network accept a crafted proof that spends another user's note.

| STRIDE | Threat | Impact | Mitigation | Residual |
|---|---|---|---|---|
| T / S | MITM or malicious host substitutes circuit files on download (or a bad upgrade overwrites a good cache) | Crafted proofs accepted → theft from any user of the pool | [V142](../scripts/wave-issues-privacy.md#v142--mobile-circuit-download-cache-and-checksum) downloads over HTTPS, verifies every artifact against SPP's published circuit lockfile **before** proving, deletes on mismatch and refuses to prove. They never ship inside the APK, shrinking the offline-tamper surface | Trusts SPP's checksum feed as published; pin the lockfile hash at deploy time so a swapped lockfile can't re-target the download |
| D | No network / dropped connection mid-download, or OS artifact purge | Privacy flows unavailable exactly when a user needs them | [V142](../scripts/wave-issues-privacy.md#v142--mobile-circuit-download-cache-and-checksum): resumable after a dropped connection, cached on device, progress + Wi-Fi hint; app size unchanged | After an app reinstall or sandbox wipe the ~12 MB must come down again; a cold, un-cached device can't prove offline |
| T | Corrupt download that passes no checksum | Prover fails at first use, mid-transaction | Checksum gate fails closed ([V142 acceptance](../scripts/wave-issues-privacy.md#v142--mobile-circuit-download-cache-and-checksum)). A mismatch deletes the file and refuses to prove — never a silent retry against a different source | None beyond availability |
| S | Malicious prover-worker URL (web) | The WASM worker that runs the proof is replaced | The web wrapper owns the worker lifecycle and loads only the bundled/own-served worker + WASM assets ([`frontend/wallet/next.config.*`, V134](../scripts/wave-issues-privacy.md#v134--web-spp-client-wrapper)); NOTICE files served for the GPLv3 compiler artifacts ([V134 acceptance](../scripts/wave-issues-privacy.md#v134--web-spp-client-wrapper)) | Web SDK is ~42 MB and loaded lazily; a supply-chain break in the SDK payload is caught by its maintainers, not us |

## 7. Bootnode (V140)

Public RPC keeps only 7 days of pool events (`ledgerRetentionWindow` 120960); the bootnode holds full history so a wallet that joins late, or returns after a week, still finds its notes (`docs/PRIVACY_COST.md` §3). Veil runs its own bootnode for the canonical pools; [V140](../scripts/wave-issues-privacy.md#v140--history-for-private-balances-past-the-7-day-rpc-window) also requires falling back to Nethermind's dev bootnode and saying so. A bootnode is a **read-only oracle** — it cannot see note contents (those are on-chain commitments) or the user's keys — but it does see **who** scans the pool, and it can choose not to answer.

| STRIDE | Threat | Impact | Mitigation | Residual |
|---|---|---|---|---|
| I | Bootnode operator logs client IPs + scan patterns → builds "who cares about the pool, when" | A linkage leak: shielded use patterns, not amounts | Run our own bootnode so the traffic lands with an operator we choose and govern, with documented hosting/storage/cost ([V140 acceptance](../scripts/wave-issues-privacy.md#v140--history-for-private-balances-past-the-7-day-rpc-window); ownership is a maintainer task: "Bootnode hosting account"). Bootnode queries carry no wallet identifier; TLS end-to-end | The operator *is* a trust point — it still sees IP + sync timing. Events are public anyway; the leak is the correlation, and no design in scope removes it |
| T / D | Malicious or compromised bootnode returns trimmed/shifted event history → wallet never finds its notes | Private balance reads as zero; funds effectively stranded | Fallback to Nethermind's bootnode when ours is unreachable, surfaced to the user ([V140 acceptance](../scripts/wave-issues-privacy.md#v140--history-for-private-balances-past-the-7-day-rpc-window)); up to 7 days of history remains reachable through plain RPC regardless, so only gaps older than the window depend on a single bootnode | A **silently-lying** bootnode (serves plausible but partial history) defeats both the fallback and the RPC scan. There is no independent full-history witness in the ecosystem; Nethermind's bootnode is developer-preview grade |
| D | Our bootnode dies (cost overrun, quota, host loss) | Late-joining users can't sync until it returns | Fallback path + documented storage growth and monthly cost so keeping it funded is an informed, standing decision ([V140 acceptance](../scripts/wave-issues-privacy.md#v140--history-for-private-balances-past-the-7-day-rpc-window)) | A coverage gap means real users lose note discovery; this is an ops burden, not a code one |

## 8. Selective disclosure (V139)

"Privacy that can't be shown to a bank, landlord or tax office is a liability." SPP supports user-initiated, note-scoped disclosure proofs bound to the party they are for; [V139](../scripts/wave-issues-privacy.md#v139--web-selective-disclosure-prove-this-payment) builds the generate (file/link) and verify flows.

| STRIDE | Threat | Impact | Mitigation | Residual |
|---|---|---|---|---|
| T | Disclosure forged or edited (wrong amount, wrong date, wrong party) | A false claim about a payment verifies | The verify page checks the proof against SPP's verifier and accepts/rejects tampered input ([V139 acceptance](../scripts/wave-issues-privacy.md#v139--web-selective-disclosure-prove-this-payment)); the disclosure is bound to the specific note and the intended party, not a free-form document | Verifiability is as strong as the SPP verifier contract — verification must target the canonical verifier ID from the [V131](../scripts/wave-issues-privacy.md#v131--privacy-feature-flag-and-spp-network-config) config, never a wallet-chosen one |
| I | Generating a disclosure leaks something about the *user's other* notes (index, nullifier set, balance) | Selective disclosure becomes disclosure | [V139 acceptance](../scripts/wave-issues-privacy.md#v139--web-selective-disclosure-prove-this-payment): a disclosure reveals exactly one payment and nothing about other notes — the proof is scoped to a single note | The ZK scope is inherited from SPP's disclosure circuit, not audited by us (see §10) |
| R | User disputes a valid disclosure ("that's not mine") | Trust in the proof as evidence collapses | Disclosures are cryptographically bound to a payment the pool can re-derive; the [V149 user guide](../scripts/wave-issues-privacy.md#v149--user-guide-what-private-means-in-veil) explains what a disclosure proves and to whom | Repudiation is only settled by the parties, not by the app |
| I | A leaked disclosure file/link (shared to the wrong channel, left on a shared device) reveals that one payment's amount + recipient | One payment's privacy lost | The disclosure is exactly one payment — blast radius is that payment only; treat it as sensitive data ([V139](../scripts/wave-issues-privacy.md#v139--web-selective-disclosure-prove-this-payment)) | No expiry/one-time mechanism is specified; a copied disclosure is a copied secret |
| S | A disclosure presented as belonging to a different payment/party | Verification fails or attributes wrongly | Party binding in the proof + verify against canonical verifier ([V139](../scripts/wave-issues-privacy.md#v139--web-selective-disclosure-prove-this-payment)) | — |

## 9. RPC proxy (V133)

The mainnet route forwards only an allow-list of JSON-RPC methods and fails over across providers; keyed upstream URLs never leave the server. This is **already implemented and tested** — `SPP_REQUIRED_METHODS` is fully covered by `ALLOWED_METHODS`, so no extension was needed ([`route.ts:33`](../frontend/wallet/app/api/rpc/mainnet/route.ts), [V133](../scripts/wave-issues-privacy.md#v133--let-the-rpc-proxy-serve-spps-calls)). SPP's own bootnode probe is plain HTTPS to `bootnodeUrl`, never this proxy.

| STRIDE | Threat | Impact | Mitigation | Residual |
|---|---|---|---|---|
| T | Open relay: anyone calls the public proxy to drain a metered upstream | Provider quota burned; wallet outages for everyone | Allow-list rejects any unknown method — including batched payloads — with 403 before forwarding ([`frontend/wallet/lib/rpcAllowlist.ts:40`](../frontend/wallet/lib/rpcAllowlist.ts), [`route.ts:54`](../frontend/wallet/app/api/rpc/mainnet/route.ts)) | Valid-client abuse (many users hammering) isn't distinguishable from an attacker; rate limiting is per-provider, not here |
| T / D | A single provider lies or dies (stale `getEvents`, expired plan) | Wallet misses notes or fails entirely | Several independent providers, tried in order, non-adjacent operators ([`frontend/wallet/lib/rpcFailover.ts:20`](../frontend/wallet/lib/rpcFailover.ts), `:80`); provider refusals detected even inside 200s ([`rpcFailover.ts:52`](../frontend/wallet/lib/rpcFailover.ts)) | A provider serving *plausible but wrong* ledger data defeats failover; RPC responses carry no per-ledger signature check in scope |
| I | Upstream URLs or keys reach the browser | Anyone can burn the quota / impersonate the provider | Configured URLs and their keys are server-only; the health endpoint returns counts, never URLs or keys ([`route.ts:80`](../frontend/wallet/app/api/rpc/mainnet/route.ts), pinned by test [`rpcFailover.test.ts:156`](../frontend/wallet/lib/__tests__/rpcFailover.test.ts)) | The proxy operator (Veil) sees all forwarded traffic and patterns |
| S | Malicious upstream feeds fabricated events/balances | Wrong balances → bad send decisions | Failover + a `cache-control: no-store` line keeps every read fresh; the SPP transact sequence (simulate + send + confirm) is allow-listed and idempotent-safe: retrying `sendTransaction` is safe by one-hash-per-tx ([`rpcFailover.ts:77`](../frontend/wallet/lib/rpcFailover.ts)) | On-chain data integrity is finally bounded by the network itself, not the proxy |
| E | Proxy coerced into calling a non-upstream URL (SSRF) | Provider spoofed | `forwardWithFailover` iterates a server-side fixed list only; the client-supplied body is JSON-RPC, never a URL ([`frontend/wallet/lib/rpcFailover.ts:80`](../frontend/wallet/lib/rpcFailover.ts)) | — |

## 10. SPP's own trust assumptions — what they mean for Veil users

Everything above is layered on SPP, which Veil does not control. This section is the honest ceiling of the whole feature: **SPP's guarantees are app-level only if its operator and its code hold.** Ground rule one from the wave — "Integrate, don't build" ([`scripts/wave-issues-privacy.md`](../scripts/wave-issues-privacy.md)) — is itself the biggest mitigation: no circuits, trusted setup or pool contracts of our own to get wrong.

### ASP operator (block/allow lists, freeze)

Pools are gated by an Association Set Provider and can freeze notes. Using the **canonical** pool keeps those roles with the shared operator instead of Veil ([`docs/PRIVACY_COST.md`](PRIVACY_COST.md) §4).

| STRIDE | Threat | Impact | Mitigation | Residual |
|---|---|---|---|---|
| D | Operator blocklists/allowlists a user's key → deposits bounce, sends refuse | Censored user can't use the pool | Choice of canonical pool keeps the gatekeeper a governed operator, not us; compliance is the design's point, not a bug. The shield review screen states plainly that the deposit is public and rules apply ([V136](../scripts/wave-issues-privacy.md#v136--web-shield-move-money-into-private)); [V149](../scripts/wave-issues-privacy.md#v149--user-guide-what-private-means-in-veil) explains block/allow lists, freeze and disclosure in plain language | The user is subject to an external actor's list decision with no appeal mechanism in the app. Censorship is real and by design |
| D | Operator freezes a note (compliance control) | Note unspendable until unfrozen | [V149](../scripts/wave-issues-privacy.md#v149--user-guide-what-private-means-in-veil) documents freeze so a frozen balance read as "not pending" is understood, not a bug | Freeze duration/grounds are the operator's, not Veil's |

### View keys

SPP has global view keys; if they sit with the operator or in weak custody, the "hidden" amounts and counterparties across the pool can be decrypted ([`PRIVACY_COST.md`](PRIVACY_COST.md) §4: "view keys should sit in MPC or TEE custody, not in an app").

| STRIDE | Threat | Impact | Mitigation | Residual |
|---|---|---|---|---|
| I | A leaked global view key decrypts the pool's shielded history | The pool's privacy is broken for everyone, retroactively | Veil holds **no** view keys, ever; on the canonical pool, custody is the operator's. If Veil ever ran its own pool (ruled out today), MPC/TEE custody would be mandatory ([`PRIVACY_COST.md`](PRIVACY_COST.md) §5) | The user's "private" balance is exactly as private as the operator's view-key custody. That key leaking is outside any Veil control or detection |
| I | An async attacker (in-app) could misuse any view key the app accidentally obtained | Pool-level disclosure | No app code path requests view keys — the wallet touches only per-user keys ([`PRIVACY_COST.md`](PRIVACY_COST.md) §4); nothing to dump if none are held | — |

### Unaudited, testnet-only code

SPP is a **developer preview, unaudited, "not yet approved for mainnet"** ([`PRIVACY_COST.md`](PRIVACY_COST.md) §1). Pool/circuit bugs are third-party risk Veil cannot fix from the wallet.

| STRIDE | Threat | Impact | Mitigation | Residual |
|---|---|---|---|---|
| T | Pool contract or circuit bug (bad statement, malleable nullifier) | Theft from, or griefing of, pool users | Testnet-only behind the V131 flag — impossible to enable on mainnet; canonical-pool deployments pinned from SPP's `deployments/testnet/deployments.json` ([V131](../scripts/wave-issues-privacy.md#v131--privacy-feature-flag-and-spp-network-config)); end-to-end testnet round trip watches every hop ([V148](../scripts/wave-issues-privacy.md#v148--end-to-end-private-payment-test-on-testnet)) | The fix cadence and audit depth are SPP's. Mainnet ship is gated on SPP audit + SDF approval (maintainer go/no-go), which is a schedule, not a code control |
| I | Event/note metadata leaks more than intended in contract events | Partial deanonymization | Code review + testnet E2E ([V148](../scripts/wave-issues-privacy.md#v148--end-to-end-private-payment-test-on-testnet)); [V149](../scripts/wave-issues-privacy.md#v149--user-guide-what-private-means-in-veil) sets expectations so users don't overclaim the guarantee | What SPP's events expose is upstream's design and only as reviewed as SPP is |

## 11. Ed25519 stealth addresses (scheme `0x0101` — gated, off by default)

Alongside SPP's shielded pools, Veil evaluates CryptoNote-style ed25519 stealth addresses with ERC-5564 view tags for Stellar (`schemeId = 0x0101`), pinned to the reference implementation [`shaibuafeez/stealth`](https://github.com/shaibuafeez/stealth) at commit `faecde092149c21ee0d2cdfff17e04e538ba31e4`. Unlike the secp256k1 side (ERC-5564 scheme 1), this ed25519 construction signs with a **raw scalar** `p = (s + (H mod ℓ)) mod ℓ` rather than an RFC 8032 seed, has **not been independently audited**, and its scheme ID `0x0101` is **not assigned by any registry**. Audited `@noble/curves` and `@noble/hashes` primitives do not audit the composed protocol.

### Default-off feature flag

Stealth sending, announcement scanning, one-time private-key derivation, and raw-scalar transaction signing are all gated behind an opt-in build flag that is **off by default on every network** (testnet and mainnet):

- **Web wallet:** `NEXT_PUBLIC_STEALTH_FEATURE_FLAG` (`1` or `true` to enable; checked in [`frontend/wallet/lib/privacy/config.ts`](../frontend/wallet/lib/privacy/config.ts) and enforced by `assertStealthEnabled` in [`frontend/wallet/lib/privacy/stealth.ts`](../frontend/wallet/lib/privacy/stealth.ts)).
- **Mobile app:** `EXPO_PUBLIC_STEALTH_FEATURE_FLAG` (`1` or `true` to enable; checked in [`frontend/mobile/lib/privacy/config.ts`](../frontend/mobile/lib/privacy/config.ts) and enforced by `assertStealthEnabled` in [`frontend/mobile/lib/privacy/stealth.ts`](../frontend/mobile/lib/privacy/stealth.ts)).
- Documented as `0` (disabled) in [`.env.example`](../.env.example). Any call to `createStealthPayment`, `scanStealthAnnouncement`, `deriveStealthPrivateKey`, or `signStealthStellarTransaction` throws `StealthFeatureDisabledError` when the flag is off.

### What breaks if the derivation or signing is wrong

Every failure mode below states explicitly what an attack or bug costs the user — **Funds**, **Privacy**, or **Both (Funds + Privacy)** — and what an attacker who exploits it can actually do.

| STRIDE | Failure / Attack | What an attacker can do | Cost to user | Mitigation |
|---|---|---|---|---|
| T / D | **Derivation mismatch** (wrong scalar endianness, reduction mod `ℓ`, label drift between web and mobile, or non-deterministic key material) | Sender derives one-time address `P = S + (H mod ℓ)·B`, but receiver derives a different scalar `p' ≠ s + (H mod ℓ) mod ℓ`. Nobody can produce a valid signature for `P` | **Funds** (permanently stranded at an unspendable one-time address) | Normative Stellar test vectors from `shaibuafeez/stealth@faecde09` pinned in both web and mobile test suites ([`frontend/wallet/lib/privacy/__tests__/stealth.test.ts`](../frontend/wallet/lib/privacy/__tests__/stealth.test.ts), [`frontend/mobile/lib/privacy/__tests__/stealth.test.ts`](../frontend/mobile/lib/privacy/__tests__/stealth.test.ts)). Key material must be deterministic (WebAuthn PRF, never random-nonce signing) |
| I / T | **Small-order or mixed-order point in meta-address (`V`) or ephemeral key (`E`)** (ed25519 cofactor `h = 8`) | Malicious meta-address `V` of order 2/4/8 collapses `shared = enc(e·V)` into at most 8 values so an observer can link payments and predict the stealth address. A hostile announcement with small-order `E` lets an attacker learn `v mod 8` from whether the receiver scans/claims it, or forces predictable shared secrets | **Privacy** (for `V` or `E` torsion probing; escalates to **Both (Funds + Privacy)** if combined with a forged spending key `S` of small order so the attacker knows the resulting address's discrete log) | Every public key — meta-address `S` and `V`, view-key `S`, and announcement `E` — is validated with `assertValidEd25519PublicKey`: exact 32 bytes, canonical `Point.fromHex` decode, `!point.equals(Point.ZERO)`, and `point.isTorsionFree()`. Covered by hostile-input tests for all 7 non-identity 8-torsion points and mixed-order points (`B + T`) |
| I / T | **Identity point `Point.ZERO` (`0100…00`) in `E` or `V`** | In `@noble/curves/ed25519`, `Point.ZERO.isTorsionFree()` returns `true`. If `sharedPoint` checks only `isTorsionFree()` (as in `shaibuafeez/stealth@faecde09`), an attacker can send `E = Point.ZERO` so `v·E = Point.ZERO` for every receiver regardless of `v`, producing a known constant view tag and probing/poisoning scanners | **Privacy** (scanner oracle / spam probing; **Funds** if `S = Point.ZERO` is accepted because `P = (H mod ℓ)·B` is spendable by anyone who learns `H`) | `computeSharedPoint` and `deriveStealthPublicKey` both call `assertValidEd25519PublicKey` (explicitly rejecting `Point.ZERO`) and also reject `Point.ZERO` outputs. Tested directly in both suites |
| T / D | **Non-decodable public key bytes** (`y ≥ p = 2^255 - 19`, non-canonical encoding, or `y` with no valid `x` on the curve) | Ambiguous or non-canonical encodings can cause different libraries to accept/reject differently or interpret the same bytes as distinct points, stranding funds or bypassing deduplication | **Funds** (stranded payment if sender accepts what receiver rejects) or **Privacy** (fingerprint of library behavior) | `assertValidEd25519PublicKey` decodes via strict canonical `Point.fromHex` and throws on any non-decodable or non-32-byte input; tested against `y = p`, `y = p + 1`, `y = 2^255 - 1`, and non-residue `y` values |
| S / I | **Nonce reuse or bias in raw-scalar signing (`signWithRawScalar`)** | Two signatures by the same one-time key `p` with the same nonce `r` algebraically reveal `p = (s₁ - s₂)·(k₁ - k₂)⁻¹ mod ℓ`, letting the attacker steal funds from that one-time address. Worse: if the attacker *also* holds the viewing key `v` (or is the sender who knows `e`), knowing `p` and `h = H(shared) mod ℓ` yields the **master spending key** `s = (p - h) mod ℓ`, compromising every past and future stealth payment | **Funds** (single payment on nonce reuse alone; **Both (Funds + Privacy)** — total loss of all stealth funds — if the attacker also knows `h`, e.g. as the sender or holder of `v`) | Nonce `r` is derived deterministically via domain-separated `SHA-512("stealth:ed25519:nonce" ‖ p)[32..64]` hashed with the message (RFC 8032 style). Still requires independent cryptographic review before mainnet default-on |
| S / I | **Weak or public root key material** (e.g. deriving `s, v` from public WebAuthn `credentialId` instead of PRF output) | Anyone who sees the public credential ID recomputes `s` and `v`, scans all payments, and sweeps all one-time addresses | **Both (Funds + Privacy)** (total compromise of all stealth balances and history) | Same rule as §4 (V132): stealth keys may only derive from secret PRF/seed material, never from `credentialId` |
| I | **Viewing key (`v`) leak** (logs, third-party scanner, compromised device) | Attacker cannot spend funds (does not know `s`), but can link every past and future stealth payment to the user and decrypt any sealed notes | **Privacy** (permanent loss of receiver unlinkability; funds remain safe unless combined with a raw-scalar signing leak) | Never log or transmit `v`; scanning endpoints must filter by 1-byte view tag only and never accept a viewing key (see #1320) |
| D | **Unassigned scheme ID (`0x0101`) collision or upstream breaking change** | Another standard claims `0x0101` or upstream changes labels/hash domain separation before standardization, causing wallets to miss or misparse announcements | **Funds** (unrecoverable payments if announcements can no longer be scanned) | Feature stays off by default behind `*_STEALTH_FEATURE_FLAG`; format/versioning is tracked separately (#1319) |

### What has to be true before the flag can default on

The default of `NEXT_PUBLIC_STEALTH_FEATURE_FLAG` / `EXPO_PUBLIC_STEALTH_FEATURE_FLAG` **must remain `off`** until every item below is satisfied and recorded in a maintainer sign-off:

1. **Independent cryptographic audit completed and published.** An external reviewer has audited the ed25519 CryptoNote derivation, domain separation, torsion/identity validation, and `signWithRawScalar` raw-scalar signing construction (including side-channel and nonce-derivation analysis), with all Critical and High findings resolved.
2. **Scheme ID standardized or formally assigned.** The ed25519 stealth scheme has an assigned, non-conflicting scheme ID in a recognized registry (or ratified Stellar/CAP specification) so announcements emitted on mainnet will not collide with or be orphaned by other wallets.
3. **Cross-platform vectors and hostile-input suites green in CI.** Web wallet and mobile test suites both pass normative reference vectors (pinned by commit) and hostile-input rejection tests (identity, non-decodable, all 7 small-order torsion points, and mixed-order points) on every PR.
4. **End-to-end Stellar stealth lifecycle shipped and verified.** Announcement transport (#1319), privacy-preserving view-tag scanning (#1320), claimable-balance send & reserve economics (#1321), sponsored/fee-bumped claiming (#1322), and C-address sweep/decorrelation with honest user-facing linkage copy (#1323) are implemented and proven on testnet.
5. **Explicit maintainer go/no-go decision.** Maintainers sign off on enabling stealth by default in a dedicated release PR rather than silently flipping the flag as part of a feature PR.

## 12. Open items and priorities

Ranked by what would hurt first:

1. **Web note storage is plaintext OPFS.** Everything else in the mobile path is encrypted at rest by design; the web path currently inherits "as safe as the browser profile". Wire the PRF-bound AES-GCM cipher ([`createLocalCipher`, `sdk/src/crypto/prf.ts:287`](../sdk/src/crypto/prf.ts)) around OPFS note state — before any web privacy release. Tracked loosely under [V134](../scripts/wave-issues-privacy.md#v134--web-spp-client-wrapper) / [V143](../scripts/wave-issues-privacy.md#v143--mobile-spp-state-storage); deserves its own checklist item.
2. **KDF must refuse legacy derivation.** If the V132 signer ever signs with the credential-ID-derived fee-payer (fallback mode in [`frontend/wallet/lib/feePayer.ts:218`](../frontend/wallet/lib/feePayer.ts)), privacy keys become reconstruction-from-public-data. V132's signer must fail closed on `legacy`, never reuse web/mobile fallbacks.
3. **Bootnode operator is a trust point.** Documented history retention and ownership are the mitigations; keep [V140](../scripts/wave-issues-privacy.md#v140--history-for-private-balances-past-the-7-day-rpc-window)'s fallback + user-facing "needs history" state so a folded bootnode fails loud.
4. **Pin circuit lockfile hashes at deploy time.** V142 checksums against SPP's published lockfile; pin the lockfile itself so a compromised feed can't re-target the download.
5. **Reconsider the bootnode direct-HTTP probe.** It goes straight to `bootnodeUrl` ([`route.ts:40`](../frontend/wallet/app/api/rpc/mainnet/route.ts)); if Veil's bootnode needs auth or allow-listing later, route it through the same proxy pattern instead.
6. **Ed25519 stealth scheme (`0x0101`) remains unaudited and gated off by default (§11).** Do not flip `NEXT_PUBLIC_STEALTH_FEATURE_FLAG` or `EXPO_PUBLIC_STEALTH_FEATURE_FLAG` to default-on until all five lifting criteria in §11 are met.

## 13. Keeping this model current

- Revisit on any privacy release, on SPP upstream updates that change derivation/storage/disclosure code, on any update to the pinned `shaibuafeez/stealth` reference commit (`faecde092149c21ee0d2cdfff17e04e538ba31e4`), and on the move to mainnet (the [maintainer go/no-go](../scripts/wave-issues-privacy.md#not-contributor-issues--maintainer-tasks)).
- The strongest low-cost checks are the ones already in tests: `SPP_REQUIRED_METHODS` coverage ([`rpcFailover.test.ts:100`](../frontend/wallet/lib/__tests__/rpcFailover.test.ts)), the V132 cross-platform key vectors, and the ed25519 stealth hostile-input + reference-vector suites.
- Report findings per [`SECURITY.md`](../SECURITY.md) (coordinated disclosure; `security@invisible-wallet.dev`). SPP-side findings go upstream to Nethermind.