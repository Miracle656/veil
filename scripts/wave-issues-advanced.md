# Wave batch 20 — advanced tier, safe to publish (DRAFT)

**Repo:** `Miracle656/veil`. **IDs:** V248–V252. **Points:** Easy 100 · Intermediate 150 · Advanced 200.

## Why these five, and not the others

The strongest advanced material in this project is the twelve issues held in `security-review/wave-issues-embargoed.md`. They stay held: they describe live, unfixed exploit paths, and V150 in particular is a full-wallet-drain recipe that is still live in `sdk/src/core.ts`. Publishing them would be publishing the exploit.

These five are the advanced work that can be described openly. Each one is a scaling limit, an API-shape problem, or a missing capability — nothing here tells an attacker anything they could not read off `main` in a minute.

## Shared with every issue

### Ground rules

- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.
- **Validate every hard-coded `C…`/`G…`** with `StrKey.isValidContract` / `StrKey.isValidEd25519PublicKey`. A length or shape check is not validation — several PRs have shipped 56-character strings that fail the checksum and satisfied a `/^G[A-Z2-7]{55}$/` test.
- **Pin assets by issuer, never by code.** Eight issuers publish the code `USDT0` on mainnet.
- Never log or render an RPC URL — provider keys live in the URL path.
- `frontend/mobile` installs with **plain `npm install`**, never `--legacy-peer-deps`. `sdk/` does need it.
- Fork PRs run no CI here, so a green or absent check is not evidence. Verify locally and say what you ran.
- **Do not report a suite as passing without seeing it pass.** A PR this month claimed a green run for a file that threw at import and executed zero tests.

### The contracts are not upgradeable

There is no upgrade entry point in `contracts/invisible_wallet/src/lib.rs` or the factory, and the mainnet factory and wallets are permanent. A contract change reaches only *future* deployments, so contract issues here are scoped to the v2 work in `docs/CONTRACTS_V2.md` — write the change and its tests, and expect it to ship with a new factory at a new address rather than as a patch.

---

### V248 · The factory stops deploying after roughly a thousand wallets

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:advanced, epic:hardening

### Background
`contracts/factory/src/storage.rs:31-33`:

```rust
pub fn mark_deployed(env: &Env, salt: &BytesN<32>) {
    env.storage().instance().set(&DataKey::Deployed(salt.clone()), &());
}
```

Every deployment writes another key into **instance** storage. Soroban instance storage is a single entry: it is size-capped, and it is loaded and written on *every* call to the contract. So each new wallet makes every subsequent deploy more expensive, and once the entry exceeds the limit the factory stops working permanently — for everyone, including wallets that already exist and want to redeploy.

This is a hard ceiling on total users, reached silently.

### What to build
- Move the deployed-set to **persistent** storage keyed per salt, so each entry is independent and nothing is loaded that the call does not need.
- Or remove the set entirely: the deployer already fails when the address exists, so the bookkeeping may be redundant. If you take this route, prove the failure mode is equivalent.
- Either way, account for the TTL/archival rules on whichever storage type you choose — a persistent entry that expires is its own bug.

### Acceptance criteria
- [ ] A test deploys enough wallets to exceed today's instance-entry limit and still succeeds
- [ ] The per-deploy cost stops growing with the number of existing wallets — show before/after numbers
- [ ] `is_deployed` still answers correctly for a wallet deployed many wallets ago
- [ ] The PR states the storage type chosen and its TTL consequences
- [ ] `cargo test` passes; the WASM size delta is reported

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V249 · Take secret keys out of the client SDK's surface

**Labels:** help wanted, Stellar Wave, area:sdk, difficulty:advanced, epic:hardening

### Background
Several SDK entry points accept a funded account's **secret key as a string** (`sdk/src/core.ts` — the sponsor and fee-payer paths). The API shape invites the wrong thing: to use them, an application has to put a live secret into a bundle that ships to a browser or a phone.

The SDK is about to be published to npm, so this shape is about to become other people's problem too, and every dependent that copies the obvious usage ships a key.

### What to build
- Replace string-secret parameters with a **signer callback** — the SDK hands over what needs signing, the application signs it wherever the key actually lives, typically a backend.
- Keep a migration path: deprecate the old overloads with a clear message before removing them, and document the replacement in the README with a worked example.
- Make the wrong thing hard: no example, test fixture or type should demonstrate passing a secret string.

### Acceptance criteria
- [ ] No public SDK function takes a secret key as a parameter
- [ ] The callback shape is documented with a runnable server-side example
- [ ] Existing consumers get a deprecation warning, not a silent break
- [ ] The api-surface snapshot is regenerated deliberately, with the diff explained in the PR
- [ ] Tests cover the callback path, including a signer that refuses

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V250 · Bulk payout: sign once, and actually submit

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:advanced, epic:send-receive

### Background
`frontend/mobile/app/bulk-payout.tsx` currently reports success without doing anything. `submitBatch` returns a synthetic `pending-…` string, always resolves, and the screen tells the user "N recipients paid in one signed batch". No transaction is built, nothing is signed, no network call is made. See **#922**.

The original reason was real — the mobile app had no signer when that screen was written. It has one now: `signXdrPayload()` in `lib/walletConnect.ts` implements the full `__check_auth` ceremony and has been spending on mainnet.

### What to build
- Build one transaction covering every row, sign it once through `signXdrPayload()`, submit it, and surface the real hash.
- `sdk/src/bulkPayout.ts` already delegates `submitBatch` to the caller and `executeBulkPayout` already routes a thrown error into `failedRows` — use that rather than inventing a second path.
- Decide and document what happens when the batch is too large for one transaction: split deliberately, or refuse with a clear limit. Silently truncating is the worst option.
- Partial failure must be reported per row.

### Acceptance criteria
- [ ] A real transaction is submitted and the hash shown is the one on chain
- [ ] The done state is unreachable without a submitted transaction — assert this in a test
- [ ] One signature covers the whole batch, which is the point of the feature
- [ ] Over-large batches are handled explicitly, with the behaviour documented
- [ ] Partial failure names the rows that did not go through

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V251 · Session keys must constrain who gets paid

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:advanced, epic:hardening

### Background
`contracts/invisible_wallet/src/lib.rs:329-335` extracts the amount from the auth context and enforces against it, but never reads the payee:

```rust
let amount = if c.args.len() >= 3 { … c.args.get(2) … } else { 0 };
session_key::enforce(&env, &key_id, &c.contract, &c.fn_name, amount)?;
```

`SessionKeyAcl` has `pubkey`, `target_contract`, `selector`, `amount_cap`, `spent`, `expiry` — and no payee. So a key scoped to "the USDC SAC, `transfer`, capped at 10 USDC" can send that 10 USDC to **any** address. The cap bounds how much leaves, not where it goes. See **#866**.

Nothing registers a session key today, so this is latent rather than live — which is why it is safe to describe here. It matters because the feature reads as safe: anyone wiring session keys later would reasonably assume the cap plus the contract plus the selector bounds the damage.

### What to build
- An optional payee constraint on `SessionKeyAcl` — a single allowed recipient, or a small allow-list — passed into `enforce()` and rejected on mismatch.
- Stop extracting arguments positionally. `args.get(2)` assumes a shape that is only true for some selectors; a per-selector description is safer and is the actual fix to the class of bug.
- Consider a per-call maximum alongside the cumulative cap. Today a single call may spend the whole remaining budget.

### Acceptance criteria
- [ ] A session key with a payee constraint rejects a transfer to any other address
- [ ] A key with no payee constraint behaves exactly as today, so nothing existing changes meaning
- [ ] Argument extraction is per-selector, and an unknown selector is refused rather than guessed at
- [ ] Tests cover the right payee, the wrong payee, and an unknown selector
- [ ] The PR states plainly that this reaches only future factory deployments

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V252 · Bind the x402 passkey prompt to the payment it authorises

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:hardening

### Background
In `examples/x402-api`, the payment is signed with the fee-payer secret (`client/src/lib/x402.ts:29`) while the passkey ceremony next to it uses a random challenge (`client/src/lib/veil.ts:46,75`). So the biometric proves a human was present at some moment — not that they agreed to this amount, to this recipient. See **#867**.

The wallet's own path gets this right: `signXdrPayload()` derives its challenge from the Soroban `HashIdPreimage` of the transaction, which is what makes the prompt mean something. Examples get copied, and this one teaches the pattern the architecture exists to avoid.

### What to build
- Derive the challenge from the payment — the transaction hash, or the x402 payload being authorised — and record the assertion alongside it.
- Or route the example through the same `__check_auth` ceremony the wallet uses, so the passkey signature *is* the authorisation.
- If neither is taken now, say so in the example's README rather than leaving it implied.

### Acceptance criteria
- [ ] The challenge is derived from the payment, and a test proves a different payment produces a different challenge
- [ ] Nothing in the example demonstrates a presence-only prompt in front of a stored-key signature
- [ ] The README states which guarantee the example does and does not provide
- [ ] While you are here: `server/src/x402.ts:41` sets `maxTimeoutSeconds: 120` (~24 ledgers) against the wallet's `+100`-ledger expiry — note or reconcile the mismatch

> **Drips Wave** · Complexity: **Intermediate** · **150 points**
