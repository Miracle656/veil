# Wave batch 16 — USDT0, and three gaps in the privacy batch (DRAFT)

**Source:** USDT0 went live on Stellar mainnet on 2026-09-02; everything below was verified against mainnet Horizon on 2026-09-24. **Repo:** `Miracle656/veil`. **IDs:** V198–V208 (batch 15 ended at V197). **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** create the `epic:usdt0` label. The privacy issues at the end reuse `epic:privacy`.

## Part 1 — USDT0

USDT0 is Tether's omnichain USDT, bridged to Stellar over LayerZero's OFT standard. Verified on mainnet Horizon, 2026-09-24:

| | |
|---|---|
| Code | `USDT0` (`credit_alphanum12`) |
| **Issuer** | `GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q` |
| **SAC contract** | `CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF` |
| Holders | 22,348 authorised |
| `auth_required` | **false** — anyone may hold it, no permission needed |
| `auth_revocable` | **true** — the issuer can freeze a trustline |
| `auth_clawback_enabled` | **true** — the issuer can take the balance back |
| `home_domain` | **none** |

The SAC was not copied from anywhere: `new Asset('USDT0', issuer).contractId(Networks.PUBLIC)` derives `CBSJZEIO…26YF` exactly. Do that yourself rather than trusting the table.

### The finding that shapes this batch

There are **eight issuers** of an asset called `USDT0` on mainnet. Here they are, as Horizon reports them:

| Holders | Supply | Clawback | `stellar.toml` | Issuer |
|---|---|---|---|---|
| **22,348** | 10,958 | **yes** | **none** | `GATISXX6…6KXJHN6Q` ← the real one |
| 375 | 210,000,000,000 | no | `quantumsystem.cc` | `GC35JBER…JFLQBANK` |
| 292 | 999,999,999 | no | `stellarusdtzero.com` | `GADUBOKG…R67HUSDT` |
| 33 | 9,999,999,999 | no | `usd-t0.com` | `GBL35PWB…25QHUSDT` |
| 3 | 9,999,974 | no | `cryptos.litemint.store` | `GAKSY7RQ…2YOD7ZP3` |
| 1 | 3,000,000,000 | no | `stellar-reserve.com` | `GA7GNGYV…UZERU526` |
| 1 | 10,000,000 | no | `tokenize.litemint.store` | `GAVRQZHG…FJ3WE77O` |
| 1 | 9,999 | no | none | `GDBDGR2U…SHOOHZFF` |

Read the `stellar.toml` column again. **The genuine asset is the only one without one.** Every impostor has published a domain and a TOML declaring itself — two of them with issuer addresses ending in the letters `USDT`.

Veil's asset verification (`scripts/verify-asset-registry.mjs`, and the home-domain checks in the registry work) treats a matching `home_domain` → `stellar.toml` as evidence of authenticity. Against USDT0 that heuristic **inverts**: it would pass all seven fakes and fail the real one. V199 exists because of this, and it is the most important issue in the batch.

## Ground rules for Part 1

- **Pin by issuer. Always.** A code match is not an asset match, and here it is seven-to-one against you.
- **Do not copy an address from this file into source without checking it.** Every `G…`/`C…` must pass `StrKey.isValidEd25519PublicKey` / `isValidContract`, and the SAC must be *derived*, not pasted.
- **A missing `stellar.toml` is not evidence of anything, in either direction.** Do not add a rule that requires one, and do not add one that rewards one.
- **Clawback and freeze must be disclosed before a user holds the asset**, not after. This is not optional copy.
- **No yield, returns or advice language.** USDT0 is a stablecoin, not a product we recommend.
- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.

---

### V198 · Add USDT0 to the verified asset registry, pinned by issuer

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:usdt0

### Background
USDT0 is live on mainnet with 22,348 holders and is the asset most Veil users are likeliest to already own somewhere else. It is not in `ASSET_REGISTRY`, so today it renders as a bare code with no issuer check.

### What to build
- Add USDT0 to the registry in `frontend/wallet/lib/assets.ts` and `frontend/mobile/lib/assets.ts`, with the issuer above, `kind: 'stablecoin'`, `network: 'mainnet'`, and no `homeDomain` (it has none — leave the field absent rather than inventing one).
- Record the SAC contract id, and add a test that **derives** it with `new Asset('USDT0', issuer).contractId(Networks.PUBLIC)` and asserts it equals the stored value. That test is what stops a wrong issuer from ever being pasted in.
- Mainnet only: USDT0 does not exist on testnet, so `getRegisteredAsset`/`getAssetIssuer` must not offer it there. Follow how `aac2e05` gated USDY.

### Acceptance criteria
- [ ] USDT0 resolves to exactly the issuer above, on mainnet only
- [ ] A test derives the SAC rather than asserting a pasted literal
- [ ] A trustline with code `USDT0` and any other issuer is *not* treated as USDT0
- [ ] Nothing offers USDT0 on testnet

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V199 · Stop treating a `stellar.toml` as evidence of authenticity

**Labels:** help wanted, Stellar Wave, area:wallet, area:ci, difficulty:advanced, epic:usdt0

### Background
`scripts/verify-asset-registry.mjs` verifies a registry entry by fetching the issuer's `home_domain` and checking its `stellar.toml` lists the currency. For USDC, EURC, AQUA and USDY that works.

For USDT0 it does the opposite of its job. The real issuer publishes **no** domain and no TOML; all seven impostors publish both, including `stellarusdtzero.com` and `usd-t0.com`. A verifier built on that signal passes the fakes and fails the asset with 22,348 holders.

There is a second, quieter bug in the same script: when a TOML cannot be fetched it logs `✓ … verified` and returns. It fails open, so an unreachable domain reads as a pass.

### What to build
- Make the script's verdict **issuer-identity first**: the registry entry is correct if the issuer account exists on the network it claims and its address matches the pinned one, byte for byte. That is the only claim the script can actually prove.
- Where a `stellar.toml` exists, use it as *corroboration* and report a mismatch as a failure. Where it does not exist, say so plainly and do not treat the absence as either pass or fail.
- **Remove every fail-open path.** A fetch that errors, times out, or returns no currencies must fail the check, not log a tick.
- Add a regression case built from the real data above: given the eight USDT0 issuers, the script must accept only `GATISXX6…` and reject the other seven — including the ones with valid, well-formed TOMLs.
- Verify the mobile registry too, not only the wallet's; today only `frontend/wallet/lib/assets.ts` is parsed, so drift between the two copies is invisible.

### Acceptance criteria
- [ ] The eight-issuer fixture passes exactly one issuer
- [ ] An unreachable or empty TOML fails the check rather than passing it
- [ ] An asset with no `home_domain` can still verify, on issuer identity alone
- [ ] Both registries are checked, and a divergence between them fails
- [ ] The script no longer runs on every push (see V205)

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V200 · Say that USDT0 can be frozen and clawed back, before it is held

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:easy, epic:usdt0

### Background
The USDT0 issuer has `auth_revocable: true` and `auth_clawback_enabled: true`. The issuer can freeze a trustline, and can take the balance back from a holder. That is normal for Tether and it is not a reason to refuse the asset — but a user who holds it should be told, in the wallet, before they opt in.

Note the flags are also the clearest on-chain signal separating the real asset from its impostors: it is the only USDT0 issuer with clawback enabled.

### What to build
- On the screen that adds the USDT0 trustline, show a short, factual line before the confirm action: the issuer can freeze this balance or take it back, and this is a property of the asset, not of Veil.
- The same fact on the asset's detail row, so it is discoverable after the fact.
- Read the flags from Horizon rather than hard-coding them, so the copy stops appearing if Tether ever clears them.

### Acceptance criteria
- [ ] The disclosure renders before the trustline is created, not after
- [ ] The wording states who can do it and what happens, in one sentence, with no hedging and no advice
- [ ] Flags come from the issuer account, not a constant
- [ ] An asset without those flags shows no disclosure
- [ ] Tests cover both flag states

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V201 · Hold USDT0: trustline, balance and price

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:usdt0

### Background
With V198 and V200 in place, the wallet can offer USDT0 the way it offers USDC. Trustlines cost 0.5 XLM in reserve, which the user must be told about before it is spent.

### What to build
- Add-trustline flow for USDT0, reusing the existing USDC path rather than a parallel one.
- Balance row resolved through the registry, so an impostor trustline renders as unverified and never as USDT0.
- Price: USDT0 is a dollar stablecoin, so the fiat column should treat it as such rather than quoting it through a swap route. Where a quote is needed, route by `code:issuer`, never by code.

### Acceptance criteria
- [ ] The 0.5 XLM reserve is stated before the trustline is created
- [ ] An impostor USDT0 trustline never renders as the registered asset
- [ ] Balances and fiat values are correct to 7 decimal places
- [ ] Tests cover a wallet holding both the real and a fake USDT0

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V202 · Send and receive USDT0, with the issuer carried end to end

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:usdt0

### Background
Send, receive, deep links and QR must all carry `code` **and** `issuer`. A payment link that names only `USDT0` is ambiguous between eight assets, seven of which are worthless.

### What to build
- Send: asset selection resolves `code:issuer`; the review screen names the issuer.
- Receive: request links include `asset_issuer`, and the QR encodes it.
- A link that carries a code with no issuer, or an unregistered issuer, is refused with an explanation rather than resolved by guessing.

### Acceptance criteria
- [ ] A link with `asset=USDT0` and no issuer is refused
- [ ] A link with an unregistered issuer is refused and names it
- [ ] The issuer survives the full round trip: request link → scan → review → submit
- [ ] Tests cover all three refusal cases

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V203 · Mobile parity for USDT0

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:usdt0

### Background
The mobile registry is a hand-maintained copy of the wallet's. Every asset added on one side and not the other is a divergence, and for an asset with seven impostors a divergence is a security bug.

### What to build
- USDT0 in the mobile registry, the assets screen, send and receive, matching V198/V201/V202.
- A parity test asserting the two registries hold the same entries with the same issuers — this is the real deliverable, and it should fail loudly when one side is edited alone.

### Acceptance criteria
- [ ] Mobile shows, sends and receives USDT0 with the issuer pinned
- [ ] The parity test fails when either registry is edited alone
- [ ] Mobile typecheck and the full jest suite stay green

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V204 · Swap into and out of USDT0

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:usdt0

### Background
USDT0 sits in 25 liquidity pools and 22 contracts on mainnet, so routes exist. The swap path must address it by `code:issuer` and by its SAC for Soroswap, never by code.

### What to build
- USDT0 as a source and destination in the swap picker, resolved through the registry.
- Soroswap routes use the derived SAC (`CBSJZEIO…26YF`); classic paths use `code:issuer`.
- Slippage and route display name the issuer, so a user can see which USDT0 they are trading.

### Acceptance criteria
- [ ] Quotes resolve by issuer and SAC, never by code alone
- [ ] An unregistered USDT0 cannot be selected as a swap asset
- [ ] A failed or unroutable quote says so rather than falling back to a different asset
- [ ] Tests cover the routing input, not just the happy path

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V205 · Move the asset-registry check off the push path

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy, epic:usdt0

### Background
`npm run verify:assets` makes live calls to `horizon.stellar.org`, `stellar.org`, `aqua.network` and `ondo.finance`, and it runs on every push. That makes every CI run depend on four third parties being up, which is flaky by construction and trains people to ignore a red check.

### What to build
- Move it to a scheduled workflow (daily is enough — issuer accounts do not change often) plus a manual `workflow_dispatch`.
- On failure, open an issue rather than failing a contributor's unrelated push.
- Keep a fast offline portion on the push path: StrKey validity, SAC derivation, and wallet/mobile registry parity all run with no network.

### Acceptance criteria
- [ ] No network call on the push path
- [ ] The offline checks still catch an invalid address, a wrong SAC, or a registry divergence
- [ ] The scheduled run opens an issue on failure
- [ ] A contributor's PR cannot go red because a third-party domain is down

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V206 · Agent: answer USDT0 questions with the verified issuer

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:easy, epic:usdt0

### Background
The agent reports balances and answers asset questions. With eight USDT0 issuers on mainnet, an agent that reports "you hold USDT0" without checking the issuer is telling the user something false the moment they hold a fake.

### What to build
- The agent's asset lookup resolves USDT0 by issuer, and names the issuer when it answers.
- A holding whose issuer is not registered is reported as unverified, explicitly, with its issuer shown.
- It states the clawback and freeze property when asked what USDT0 is.

### Acceptance criteria
- [ ] A wallet holding a fake USDT0 is told it is unverified, with the issuer
- [ ] A wallet holding the real one is told which issuer it is
- [ ] Balances are never aliased to a registry entry on a code match alone
- [ ] Tests assert the tool output, not the model's closing text

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

## Part 2 — three gaps in the privacy batch

The privacy batch (V131–V149, issues #710–#728) already covers the flag and config, key derivation, the RPC proxy, the client wrapper, balance/shield/send/unshield, selective disclosure, bootnode history, the mobile prover track, fees, the threat model, the e2e test and the user guide. **Do not re-file any of that.** These three are the gaps found while reviewing that batch's first wave of PRs.

---

### V207 · Notice when our pinned SPP config drifts from upstream

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate, epic:privacy

### Background
`frontend/wallet/lib/privacy/config.ts` pins SPP's contract ids and names the upstream commit they came from. Its test asserts those values against literals copied into the test file, so it catches an edit to the config and **cannot** catch the thing that actually matters: Nethermind redeploying and our pins going stale. A stale pool id means private transactions are sent to a contract nobody is using.

### What to build
- A check that fetches `deployments/testnet/deployments.json` from `NethermindEth/stellar-private-payments` and compares it field by field against the pinned config.
- Report a drift as a failure that names each changed key and both values, so the fix is a copy of the diff.
- Scheduled, not on the push path, for the same reason as V205 — and it must not fail a contributor's PR because GitHub was briefly unreachable.

### Acceptance criteria
- [ ] A changed pool, verifier, ASP or registry id is reported with old and new values
- [ ] An unreachable upstream is distinguishable from a real drift
- [ ] It runs on a schedule and opens an issue on drift
- [ ] A test proves detection using a fixture that differs by one id

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V208 · Choose an association-set policy, and tell the user what it means

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:privacy

### Background
SPP's pools carry `policyFlags: ["blocklist"]` and the deployment ships two association-set contracts, `asp_membership` and `asp_non_membership`. An Association Set Provider decides which deposits a proof may be built against. That is a compliance choice with a direct privacy consequence — a narrower set is a smaller anonymity set — and Veil has not made it explicitly anywhere.

This is a decision issue as much as a code one. It needs a written answer before the shield flow ships.

### What to build
- Document which association set Veil uses and why, in `docs/PRIVACY_COST.md` or an ADR: what the blocklist excludes, who maintains it, and what happens to a user whose deposit is later excluded.
- Surface it in the client: the shield flow should name the policy in force, and a proof that fails because of it must say so rather than reporting a generic proving error.
- State the privacy consequence honestly — the anonymity set is everyone else in the same pool under the same policy, not "everyone".

### Acceptance criteria
- [ ] The chosen policy is written down with its reasoning, and dated
- [ ] A policy-rejected proof is distinguishable from a failed one in the UI
- [ ] The user-facing text does not overstate the anonymity set
- [ ] A change of policy is a config change, not a code change

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V209 · Publish your privacy key so other people can pay you

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:privacy

### Background
V132 derives privacy keys from the passkey, and V136 looks a recipient up in SPP's `public_key_registry` in order to send to them. Nothing enrols *your* key into that registry — so under the current set of issues every Veil user can send privately and nobody can receive.

### What to build
- An enrolment step that publishes the wallet's privacy public key to SPP's `public_key_registry` contract, once, idempotently, and only when the privacy flag is on.
- Make it recoverable: the key is derived from the passkey, so enrolment must be re-runnable on a new device and must detect that the key is already registered rather than paying to write it twice.
- Show enrolment state in the privacy UI, because "why can nobody pay me" is otherwise invisible.

### Acceptance criteria
- [ ] A fresh wallet can enrol, and a second enrolment is a no-op
- [ ] A wallet restored on a new device detects its existing registration
- [ ] The state is visible in the UI, with the action to fix it when absent
- [ ] Nothing enrols while the privacy flag is off
- [ ] Tests cover the already-registered path

> **Drips Wave** · Complexity: **Intermediate** · **150 points**
