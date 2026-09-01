# NGN rails for Veil — onramp, conversion, bills

_Research completed 2026-08-21 (5 web-research agents + 3 adversarial verifications; all
three load-bearing claims CONFIRMED). This is the reference for the "naira in → USDC out,
bills paid" product layer._

## The idea being validated

> "When users are in naira view and press Receive, it creates a Nigerian bank account
> number they can transfer to; deposits onramp to Stellar."

**Verdict: not crazy — it's the standard onramp pattern** (Bitnob does exactly this with
per-user unique account numbers; Roqqu similarly; Beans App is the closest Stellar
analogue). Veil's twist — the crypto stays invisible behind a naira balance on a
self-custodial smart wallet — is the differentiator, not the risk.

## The three verified claims

1. **Per-user NGN virtual accounts without a PSP licence: CONFIRMED.** The provider holds
   the CBN licence; you're a merchant. Flutterwave even onboards an **"Unregistered
   Business Account"** (BVN + NIN + ID + website/social page + proof of address) — a
   pre-CAC path. Paystack/Monnify want CAC + company-named settlement accounts.
2. **Programmatic NGN → USDC on Stellar: CONFIRMED.** **Busha Business API**
   (SEC/ARIP-licensed, docs verified live 2026-08-21): NGN bank-transfer deposits (flat
   ₦150) → quote-locked conversion → **USDC-XLM withdrawal** (1 USDC fee). Native XLM too.
3. ~~**"Licensed partner converts, we do UX + self-custody": CONFIRMED.**~~
   **⚠️ DOWNGRADED 2026-08-23 — see "The licensing question" below. Busha marketing this
   to unlicensed fintechs is not the same as it being lawful for us, and a Nigerian
   tribunal has already restrained a company running exactly this structure.** Treat the
   commercial go-ahead from a provider as necessary but nowhere near sufficient.

## Recommended stack

| Layer | Primary | Fallback / notes |
|---|---|---|
| **Onramp (deposit → USDC-XLM)** | **Busha Business** end-to-end (their virtual accounts + conversion + Stellar payout, memo required) | Split model: Monnify reserved accounts (1.5% capped ₦2k / ₦500 flat, same-day settlement incl. weekends) collecting, Busha converting |
| **Virtual accounts (if split)** | Monnify (BVN/NIN per user, CAC required) | Flutterwave (2% UNCAPPED — poor for big deposits, but unregistered-business path exists); **NEVER Paystack** — their ToS explicitly ban crypto operators |
| **Bills — build FIRST** | **eBills.africa** — the only rail an individual can sign up for today *and* whose timeouts are recoverable (see §Bills deep-dive) | — |
| **Bills — once we have an entity** | **Monnify Bills API** (real sandbox; explicit "requery does not re-charge"; 0.5–2% commission; needs activation email + merchant review) | Flutterwave Bills v3 (11 categories, but v3→v4 migration risk; IP whitelisting) |
| **Bills — fallbacks** | Plustive (best idempotency of the four, but sales-provisioned + static-IP allowlist) | Pairgate (real `/test` mode, but unrecoverable timeouts — see deep-dive; **do not make it primary**) |
| **Stellar-native option** | **NGNC by Link.io** — the ONLY live SEP-24 NGN anchor; works technically, economically dormant. **Demo rail, not production** — see the anchor survey below | Cowrie/NGNT is SEP-6-only (our client can't speak to it) and a zombie; everything else is dead |

**Ruled out:** Yellow Card retail (dead Jan 2026; B2B API is strong but KYB/partnership-gated
with undisclosed pricing — revisit at scale), MoonPay (exited Nigeria), Cashramp (no Stellar
— Celo/Optimism/Base only), cNGN (not on Stellar), Baxi (dev portal dead), SquadCo VAS
(airtime/data only), OPay bills (airtime/betting only — prior research), VTpass (banned by fiat).

## Stellar anchor survey — verified 2026-08-23

_Every TOML and `/info` below was fetched directly; on-chain figures come from Horizon._

**Verdict: NGN anchoring on Stellar is technically viable and economically not.** Exactly one live SEP-24 NGN anchor exists, and it carries no volume.

### NGNC by Link.io — the only one, and it does work

Issuer `GASBV6W7GGED66MXEVC7YZHTWWYMSVYEY35USF2HJZBLABLYIFQGXZY6`, home domain `ngnc.online`, operated by **LINK.IO LTD (UK-registered)**. TOML declares SEP-10 (`anchor.ngnc.online/auth`) and **SEP-24** (`/sep24`) — and notably **no SEP-6, SEP-12, SEP-31 or SEP-38**. `NGNC` is `live`; the Ghana and Kenya tokens are `pending`.

Live `/info`: deposit **min ₦20,000 / max ₦20,000,000**; withdraw **min ₦10,000 / max ₦5,000,000**; **fee 0**; `account_creation: true` and `claimable_balances: true` — both genuinely useful for an invisible-wallet onboarding flow, since the anchor can fund a brand-new wallet. SEP-10 returns a well-formed challenge, so **our existing client should authenticate with no code changes**.

**But the economics are the problem:** 6,170 trustlines, ~83.2m NGNC issued (**≈$70k**), and exit liquidity that rounds to nothing — the entire NGNC↔USDC AMM pool holds **24.54 USDC**, the order book shows a **4.6× bid/ask spread**, and the deepest pool is against GHSC, the anchor's own unlaunched token. Primary-market throughput over six weeks was **two operations**: a 1,000,000 mint and an immediate 1,000,000 burn — a treasury self-test, not customer flow. The pool's implied rate (₦1,178/$) is far off the ~₦1,500 market, which is itself proof nobody is arbitraging it.

Encouragingly the anchor is *maintained* — endpoints answer, TLS is valid, someone minted five days ago. It is simply not being used.

### Everything else

- **Cowrie Exchange (NGNT)** — the notable near-miss. TOML is live, 8,815 trustlines, and its SEP-6 `/info` is startlingly concrete (withdraw min **₦300**, ₦200 fixed fee, 23 Nigerian banks by name — limits ~200× friendlier than NGNC). But it declares **SEP-6 only, no SEP-24**, so our client cannot talk to it at all, and on-chain it is a zombie: issuer activity is dust, one distribution account has been silent since July 2025, and the NGNT/USDC book shows a ~190,000× spread. Legacy stock from its active 2019–21 era.
- **Dead:** `flutterwave.com` serves no TOML (404) despite an issuer pointing its home domain there; `kubitx.com` (NGNX) 404; `tonaira.com`, `pingme.ng`, `sendwise.org`, `interstellar.exchange` all fail to resolve.
- **cNGN is confirmed NOT on Stellar** — Horizon returns zero assets for the code, and cNGN's own docs list EVM chains, Solana, Tron and **Bantu**. Bantu is a *Stellar-codebase fork* with its own passphrase and Horizon (its cNGN address is a G-address), popular in Nigeria and **not interoperable with Stellar mainnet** — though our SDK and SEP tooling would largely port. Separate investigation if it ever matters.

> ⚠️ **Never match an asset on the code `NGN`/`NGNT` alone.** Those codes are heavily squatted: Horizon returns issuers with home domains like `bankofengland.com.co`, `federalreserve.us.com`, fake `circle.com` and `lobstr.co`, one with 2.7 *trillion* NGN issued to 8 accounts. Always pin the issuer and verify its home-domain TOML.

### SDF testnet anchor — and a find that matters more than the NGN answer

`testanchor.stellar.org` is fully live with the complete SEP stack. SEP-24 withdraw works for **SRT, USDC and native XLM** (min 1, max 10, fees disabled) — so a legitimate testnet offramp demo is exercisable today with no partner and no legal exposure.

**🔑 SEP-45 is live on it:**
```
WEB_AUTH_FOR_CONTRACTS_ENDPOINT = https://testanchor.stellar.org/sep45/auth
WEB_AUTH_CONTRACT_ID            = CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX
```
**SEP-45 is contract-account authentication** — a Soroban smart wallet authenticating to an anchor directly, instead of needing a classic G-account keypair to sign a SEP-10 challenge.

This is architecturally significant for Veil specifically. SEP-10 verifies an ed25519 signature over a classic account, which is why `app/withdraw.tsx` has to authenticate as the fee-payer rather than as the user's actual wallet — a workaround, not a design. **SEP-45 is the correct primitive for a contract-based passkey wallet**, and it is testable today on SDF's reference anchor. Neither NGNC nor Cowrie declares it yet, but SDF shipping it in the reference implementation signals where the standard is going. Worth its own spike.

## Offramp deep-dive — USDC-on-Stellar → NGN → bank

_Researched 2026-08-23 against `docs.busha.io` (all 131 pages), the official OpenAPI spec (9,359 lines), and **live unauthenticated probes of both `api.busha.co` and `api.sandbox.busha.so`**. Every claim below marked "verified" was reproduced 3× and deterministic._

### The three answers that matter

1. **USDC-on-Stellar offramp works in PRODUCTION** — verified empirically, not inferred.
2. **Native XLM offramp does NOT work** — deterministic 503, and it would cost 4.5× more anyway.
3. **You CANNOT demo the USDC-on-Stellar offramp in SANDBOX** — the decisive constraint on a build-before-CAC plan.

### Verified probe results

| Test | Env | Result |
|---|---|---|
| `USDC` + `pay_in{address, network:XLM}` → NGN | **PROD** | **201 CREATED** |
| same | SANDBOX | **503 service_unavailable** |
| `XLM` native + `pay_in{address, network:XLM}` | PROD | **503** |
| `USDC` + `network:BANANANET` (control) | PROD | `400 "BANANANET is not supported by USDC"` |
| `USDC`/`XLM` → NGN via `pay_in: balance` | SANDBOX | **201** |

The bogus-network control is load-bearing: the `network` field **is** server-side validated, so `XLM` returning 201 for USDC means production genuinely accepts Stellar — it isn't ignoring the field. Root cause of the failures is a currency-level `is_ramp_sell_supported` flag: production enables USDC, **sandbox does not**, and `XLM` is disabled in both.

### The flow (no dedicated "offramp" endpoint — it's one quote→transfer primitive)

```
POST /v1/recipients/resolve-bank-account   → account_name (verify before showing the user)
POST /v1/recipients  {type: ngn_bank}      → recipient_id
POST /v1/quotes  {source: USDC, target: NGN,
                  pay_in:  {type: address, network: XLM},
                  pay_out: {type: bank_transfer, recipient_id},
                  header X-BU-PROFILE-ID: <customer_id>}   ← B2B2C attribution
POST /v1/transfers {quote_id}              → pay_in.address (+ pay_in.memo?)
   user sends USDC on Stellar (min 2 USDC, before pay_in.expires_at)
GET  /v1/transfers/{id}  +  webhooks
```
`GET /v1/banks?currency=NGN&country=NG` is public and returns 173 banks. **Quotes expire in 30 minutes** — always mint a fresh one immediately before `POST /v1/transfers`.

### ⚠️ The memo question — unresolved, and it's the one that can lose user funds

**Not documented anywhere.** What is known:
- The **request** schema (`PayInObj`) has no memo field — you cannot supply one.
- The **response** schema does: `PaymentObj` includes `memo`, `address`, `expires_at`. So the deposit-address response *can* carry one.
- Stellar is the **only** network with a named memo example in the entire spec (`crypto_stellar_lumens_with_memo`) — but it's an *outbound recipient* example, not a deposit.
- The XLM `address_regex` is `^G[A-D]{1}[A-Z2-7]{54}$` — **plain G-addresses only, no muxed M-addresses.** Muxed is the only memo-free way to attribute deposits on a shared Stellar account, so its absence points toward memos.
- Documented attribution elsewhere is by **unique per-transfer address with `expires_at`**, not memo.

**Engineering rule: always read and honour `pay_in.memo` if present; never assume a bare G-address deposit gets credited.**

### Costs — the spread is the real fee, and it is observable

Measured live from `/v1/pairs` on 2026-08-23:

| Pair | Sell rate (ours) | Haircut vs mid | Round-trip |
|---|---|---|---|
| **USDCNGN** | 1382.12 | **0.59%** | 1.19% |
| XLMNGN | 261.39 | **2.66%** | 5.31% |

**Route through USDC, never offramp native XLM** — 4.5× the spread. Plus **₦107.50** flat payout fee (VAT inclusive) and **₦50 stamp duty** above ₦9,999; no crypto-deposit fee exists. Doc examples contradict the fee page, so **treat the quote's `fees[]` array as authoritative**. Minimums: 2 USDC in, ₦499 out (max ₦100m).

Business KYB limits: Sole Prop tier 1 = $100k/day, LLC tier 1 = $1m/day, LLC tier 2 unlimited. **End-customer individual tier limits are NOT published** — a real gap; we cannot model per-user caps from public docs.

### Settlement, webhooks

`/v1/countries` gives NGN bank-transfer `processing_time: "0-15 minutes"`, defined in the spec as an **average, not an SLA**. NIP/NIBSS is **never named** in any Busha document, and there is **no weekend/holiday or cut-off statement** — the docs hedge once about "banking hours", and the retail ToS ("each business day") contradicts the Corporate Agreement ("instantly").

Webhooks: `x-bu-signature` = base64(HMAC-SHA256(raw_body, secret)). Offramp-relevant events include `transfer.funds_received → funds_converted → outgoing_payment_sent → funds_delivered`, plus `transfer.failed`, `funds_not_delivered`, and `funds_refunded`. ⚠️ **The offramp sequence itself is never documented** — that chain is inferred by symmetry with the documented on-ramp.

### Restrictions

- **Source-address whitelisting: does not exist.** Zero hits across all 131 pages and the full spec; the per-transfer generated-address model is structurally incompatible with it.
- **Travel rule / source-of-funds: thorough negative.** No vendor named (no Chainalysis/Elliptic/TRM/Notabene/Sumsub), no API surface to submit originator data, no compliance/hold status in the documented status set, and **no statement anywhere about deposits from unhosted wallets**. They're a licensed VASP so screening almost certainly happens — but it is undocumented, so plan for the possibility without being able to cite rules.
- **Payout to a bank account not in the end-customer's name:** the retail ToS bans it outright, but that document **explicitly excludes corporates**, and the Corporate Client Agreement contains no such prohibition. `Recipient.owned_by_customer` is response-only (Busha computes it) and models both states. **Not affirmatively permitted in writing — get this confirmed before building on it.**

### What this means for building before CAC

**Sandbox business accounts are auto-verified — no CAC needed** (`sandbox.dash.busha.io/business/signup`, verified live). Production access requires **KYB = Certificate of Incorporation**, ~72h turnaround. So:

- ✅ Buildable today: the whole quote → transfer → webhook pipeline, demoed either with **USDT on TRX/ETH/BSC** (verified 201 in sandbox) or with **`pay_in: balance`** for USDC→NGN, which exercises conversion + payout and stubs only the Stellar deposit leg.
- ❌ Not demoable today: the actual USDC-on-Stellar deposit, because sandbox lacks the ramp-sell flag and its "Test Addresses For Off-Ramp Operations" page lists 9 networks with **Stellar absent**.
- Minor doc bug: the sandbox widget host `sandbox.sell.busha.io` is NXDOMAIN; the working host is `sandbox.sell.busha.co`.

### Questions to put to Busha in writing

1. Does `pay_in` for USDC-on-Stellar return a **`memo`**, is it mandatory, and what happens to a memo-less deposit? (We cannot test this — no Stellar sandbox asset exists.)
2. Will `POST /v1/transfers` actually issue a Stellar deposit address, given `USDC-XLM` is flagged `is_ramp_sell_supported: false` at **network** level even though the quote succeeds at **currency** level? *(This is the single biggest unverifiable risk in the whole path.)*
3. Does the Corporate Client Agreement permit NGN payouts to a bank account **not in the end customer's name**?
4. Can sandbox `USDC` be ramp-sell-enabled? **That one flag is all that stands between us and a complete pre-registration demo.**

## Bills deep-dive — implementation reference

_Second research pass 2026-08-23: every provider's live API probed unauthenticated, **with a bogus-path 404 control on each host** so that a `401` actually proves a route exists. eBills/Pairgate/Plustive passed the control (route existence verified); **Monnify's gateway 401s before routing**, so its paths come from the official Node SDK source, not from probing._

### ⚠️ Correction: the "data 10%" premise is mostly wrong

The table above previously sold eBills on 10% data margins. Live pricing (computed from the undocumented `reseller_price` field on the public variations endpoint) says otherwise:

Re-confirmed first-hand 2026-08-24 against the public `variations/data` endpoint, which returns an undocumented `reseller_price` beside the face `price`. Margin is `1 − reseller_price / price`:

| Network | plans | median | max | SME plans | SME availability |
|---|---|---|---|---|---|
| MTN | 39 | **1.00%** | 1.00% | **0.00%** | **all Unavailable** |
| Airtel | 36 | 1.00% | 2.33% | 1.37–2.33% | **all Unavailable** |
| Glo | 18 | 2.00% | **10.00%** | **10.00%** | **Available** |
| 9mobile | 10 | 2.00% | 2.00% | — | — |
| Smile | 12 | 3.00% | 3.00% | — | — |

**The advertised "10.00% discount on data" is true of exactly one thing: Glo SME.** Everything else pays 1–3%. And the availability column is the part that finishes the argument — **every MTN and Airtel SME plan is currently marked `Unavailable`**, so the tiers that would carry Nigerian volume cannot be sold at all, at any margin. Glo SME is the only SME inventory actually in stock, and Glo is a distant third by subscriber share.

Airtime does check out at 2.5% (MTN) / 3% (others), matching the rate card. Cable-TV variations expose **no** `reseller_price` at all, so the claimed 1.5% there is not publicly verifiable.

**Conclusion: bills is a retention feature, not a revenue line.** No model may assume 10%. Re-verify on a funded account before that changes.

### The property that decides everything: can you recover a timed-out vend?

A bill vend that times out may or may not have delivered. If you cannot ask "what happened to *my* reference?", you have an unresolvable orphan that charged a real user.

| | eBills | Monnify | Pairgate | Plustive |
|---|---|---|---|---|
| Sign up today, no CAC | ✅ individual form | ❌ activation email + merchant review | ✅ individual form | ❌ sales-provisioned |
| Sandbox / test | ❌ none | ✅ real sandbox | ⚠️ `/test` stub (verified real, static) | ❌ none |
| **Recover a timed-out vend** | ✅ requery by *our* `request_id` | ✅ requery, "does not re-charge" | ❌ **only by server `reference_code`** | ✅ replay + lookup by `clientReference` |
| True idempotent replay | ⚠️ ambiguous 3-min window | ❓ undocumented | ❌ 422 reject | ✅ replay flag + 409 conflict |
| Auto-refund | ✅ (no SLA) | ❌ undocumented | ✅ (no SLA) | ✅ **in the ToS** (no SLA) |
| Webhook on vend result | ⚠️ manual-complete + refund only | ❌ **no bills event exists** | ✅ HMAC, 3 retries | ✅ HMAC, terminal only |
| Published rate limit | ❌ | ❌ | ✅ 60/min | ❌ |
| Serverless-friendly | ✅ | ✅ | ⚠️ unresolved | ❌ **static egress IP required** |

**Poll, don't trust webhooks.** eBills fires nothing on ordinary success and Monnify has no bills webhook at all, so a requery/reconciliation loop is mandatory infrastructure for both primary rails.

### eBills — the first adapter

- **`https://ebills.africa/wp-json`** (WordPress REST). **No sandbox** — docs advise small live transactions.
- Auth: `POST /jwt-auth/v1/token` with dashboard username/password → 7-day JWT, then `Bearer`. **Only the newest token stays valid** — never let two workers log in independently. IP allowlist optional.
- Verified routes: `GET /api/v2/balance`; `GET /api/v2/variations/data?service_id=mtn` and `/variations/tv` (**public, no auth**); `POST /api/v2/verify-customer`; `POST /api/v2/{airtime,data,electricity,tv,epins,betting}`; `POST /api/v2/requery`. There is **no** `variations/electricity`, `variations/airtime`, or `/services` — those `service_id` lists must be hardcoded.
- Purchase body `{request_id, phone|customer_id, service_id, variation_id|amount}`; electricity verify returns the richest payload of the four (`customer_name`, `address`, `arrears`, `min/max_purchase_amount`).
- **Idempotency:** `request_id` ≤50 chars, and requery takes it back — so a lost response is always recoverable. Caveat: docs define two conflicting 409s (`duplicate_request_id` = permanent vs `duplicate_order` = 3-minute window), so whether a replay after 3 minutes double-vends is **genuinely ambiguous**. Until support confirms: **on timeout, requery — never blind-retry.**
- Webhook signature is HMAC-SHA256 keyed on your **account transaction PIN**, which couples webhook verification to a spending credential — treat that PIN as a high-value secret.
- `429 wallet_busy` exists alongside `429 rate_limit_exceeded`; back off on both. Top-up mechanism is undocumented publicly.
- **Onboarding: name/email/phone/password, no CAC field.** Tier 1 (email) ₦50k/day → Tier 2 (BVN) ₦500k/day → Tier 3 (face + ID + address) unlimited. **One gate to resolve on day one:** transactional endpoints need the **"reseller role"** — the docs state it as a requirement but never say how it is granted, and that page is behind the login wall.
- Operator is **FraNKAPPWeb Technologies, BN 2384195** — a registered *Business Name*, not a limited company, run from Awka, Anambra. That is fine for a bills aggregator (they are not a VASP and need not be a body corporate) but it does size the counterparty: this is a small operation, so treat float held with them accordingly and do not park more than a working balance.
- Support: `support@ebills.africa`, WhatsApp +234 810 536 5830, Mon–Sat 9–5 WAT. API changelog shows v1.0 May 2022 → v2.0/v2.1 April 2025, so it is maintained but not fast-moving.

### Monnify — right rail, wrong time

Sandbox `https://sandbox.monnify.com`, live `https://api.monnify.com`; `Basic base64(apiKey:secretKey)` → bearer token. Paths (from the official SDK): `/api/v1/vas/bills-payment/{biller-categories,billers,biller-products,validate-customer,vend,requery}`. `validate-customer` is **mandatory before vending** and returns `vendInstruction.requireValidationRef`. **Field-name conflict:** docs say `vendAmount`/`vendReference`, the SDK validator requires `amount`/`reference` — production implementations send **all four** until confirmed. `vendStatus` takes precedence over `status`. Vend needs a **>5s timeout** (30s in practice). Bills debit the merchant account with commission credited at settlement — not a separate float wallet; the `Low Balance Alert` webhook is the float monitor. **Refunds for failed vends are undocumented** — a real gap. Onboarding needs an activation email *plus* corporate KYC (TIN, CAC, MemArt, board resolution, settlement account in the business name); a community-reported "Starter Business" path could **not** be confirmed on any official page.

### Pairgate — do not make it primary

`https://pairgate.com/api/v1`, static bearer key, self-serve individual signup. The **`/test` simulate mode is real** (verified: `/api/v1/test/data/purchase` is POST-only and exists, bogus paths 404) but it is a **static stub** — different response shape, no `reference_code`, no webhook, always succeeds. The disqualifier: you send `reference`, it returns a *different* `reference_code`, a duplicate `reference` gets **422 with no `reference_code` in the body**, and `GET /transaction/status` accepts **only** `reference_code`. One timed-out purchase therefore becomes permanently unresolvable. Also 60 req/min (≈12–20 orders/min at 3–5 calls each) with no `Retry-After`, and no funding API.

### Plustive — best engineered, hardest to reach

Correct host is **`plustiveimpact.com`** (plain `plustive.com` is dead). API `https://api.plustiveimpact.com`, and the path prefix is **`/api/v1`** — marketing writes `/v1` and is wrong; the advertised OpenAPI spec 404s. **All money is integer kobo except airtime `amount`, which is whole naira.** Best idempotency of the four: replay returns the original with `idempotentReplay: true`, differing params give `409 idempotency_conflict`, and lookup accepts your own `clientReference`. Auto-refund is **contractual (in the ToS)**, not just marketing. Blockers: **no self-serve signup at all** (sales-provisioned) and **manual IP allowlisting** since July 2026, which rules out dynamic serverless egress. The "DB-level idempotency on `request_id`" note in earlier research was half-invented — the field is `clientReference` and the DB claim appears only on marketing pages.

## ⚠️ The licensing question — the "we're just the tech layer" posture is not safe

_Legal research 2026-08-23, reading the gazetted ISA 2025 text and the SEC's own rules and circulars directly. This **supersedes** the earlier "CONFIRMED" verdict on claim 3 above. Not legal advice — but the direction of travel is clear enough to plan around._

**The problem: self-custody defeats the *custody* limb of the VASP definition, but not the *arranging* limb.**

- **ISA 2025** (commenced 25 Mar 2025) puts virtual assets squarely in scope: s.357 defines securities to include *"virtual and digital assets"*, and Second Schedule Part I ¶4 makes them an Investment.
- **Second Schedule Part II ¶2 — "Arranging deals in Investments"** — covers *"making, offering or agreeing to make arrangements with a view to another person buying [or] selling … a particular investment."* Taking a user's "sell my USDC for naira" intent and passing it to a provider is arranging.
- Unlike the UK regime this language was borrowed from, **ISA 2025 has no exclusions schedule** — there is no "arranging through an authorised person" carve-out.
- **s.61(1)+(4)** makes doing this unregistered a **criminal offence**: *"a fine of not less than N5,000,000 or imprisonment for a term of not less than five years or both."*
- The SEC's **Digital Assets Intermediary (DAI)** category exists precisely to catch *"any person other than a DAOP, DAX or DAC seeking to facilitate virtual assets transactions."*

**The precedent — and it is uncomfortably close to us.** In **SEC v. Chaka Technologies**, a Nigerian consumer app gave users access to foreign shares while a licensed foreign broker did the execution and held the assets. Chaka held no client assets and executed nothing — it arranged and it marketed. The Investments and Securities Tribunal **restrained it anyway** for operating unregistered. Chaka's route out was to get licensed; it now appears on the SEC register as a Digital Sub-Broker. That was under the *old* Act — today the arranging limb is express statutory text with criminal liability attached.

**There IS a written exemption, and it is too narrow to lean on.** SEC Digital Asset Rules 2022, Part D, Rule 1.3 exempts a technology provider supplying infrastructure *to a DAX*, communication infrastructure *routing orders*, or a financial portal aggregating links. A branded consumer wallet with its own users, UX and economics is none of those. Worse, **Rule 1.1 above it is drafted very wide** — covering *"reception, transmission and execution of orders on behalf of other persons"* — and **it is unverified whether Rule 1.3 even survived the 30 June 2025 amendments**, because the amended rules are not published on sec.gov.ng. A rule-level exemption also cannot cure a statutory offence in any case.

**Capital, if we went the licensed route** (SEC Circular 26-1, 16 Jan 2026, compliance deadline 30 Jun 2027) — note these **doubled twice** since the ₦500m figures still circulating on legal blogs:

| Category | Minimum capital |
|---|---|
| Ancillary VASP (AVASP) | ₦300m |
| **Digital Assets Intermediary (DAI)** — the cheapest that fits us | **₦500m** |
| Digital Assets Exchange / Custodian | ₦2bn |

**ARIP does not make this cheaper** — ₦200k assessment + ₦2m processing, and it still requires *"evidence of required shareholder fund"*. It buys speed, not a capital waiver. Note also that **nobody in Nigeria holds a full SEC VASP registration** — the SEC's operator registry has no digital-asset category at all. Busha, Quidax, KuCoin et al. are all running on ARIP Approvals-in-Principle.

**A Business Name (sole proprietorship) cannot work for this**, whatever it costs: CBN restricts crypto-designated bank accounts to entities *incorporated in Nigeria **and** licensed by the SEC*, and the SEC rules require a VASP to be *"structured as a body corporate."*

### ⚡ The development that may rescue this: the July 2026 Executive Order

The **Executive Order on Virtual Assets Coordination (signed 17 July 2026)** splits jurisdiction: **SEC regulates virtual assets that are securities; the CBN regulates payment, settlement and custody activities.** It creates a Virtual Asset Council (CBN Governor chairing, SEC DG as vice) and a Virtual Asset Office hosted at the CBN — **and directs the CBN to launch a dedicated regulatory sandbox.**

**A crypto→NGN cash-out is payment/settlement, not securities issuance.** Under this Order that arguably lands us with the CBN rather than the SEC — and a CBN sandbox would be a vastly cheaper door than ₦500m of DAI capital. The Harmonised Implementation Framework is the thing to watch.

### What this means for us, concretely

| Activity | Verdict |
|---|---|
| Testnet wallet, testnet assets, simulated naira | **Safe** — nothing is an investment, no deal arranged, no fiat exists |
| Mock offramp with clearly-labelled fake quotes | **Safe**, provided the UI is unambiguous and we don't solicit funds |
| Sandbox integration against a provider's test API | **Safe** — no real orders, no real fiat |
| **Real user, real crypto, real naira out — even with the partner doing everything** | **Regulated.** s.61 criminal exposure, plus ARIP's ₦10m minimum penalty for unregistered brokers/advisers |
| **Marketing a live offramp to Nigerians before registering** | **Regulated** — the SEC's 14 May 2026 notice expressly reaches *promotion*. This is what got Chaka restrained |

**The realistic options** are DAI registration (₦500m), ARIP with a licensed partner, a **written Rule 2.0 exemption obtained before launch** (self-custody + a fully licensed executing partner is the strongest possible fact pattern to argue — but apply, don't assume), or becoming a genuinely white-labelled feature *inside* a partner's regulatory perimeter. **What we must not do is self-classify as a technology service provider and launch.**

**Two actions worth more than any further desk research:** email `innovation@sec.gov.ng` / `fintech@sec.gov.ng` asking directly whether a non-custodial wallet referring users to a licensed VASP falls under Rule 1.3 or needs DAI registration — a written answer outranks every analysis here; and watch for the Virtual Asset Council's Harmonised Implementation Framework, which may move this to the CBN entirely.

**Also note: NDPR registration is separate and unavoidable.** A fintech wallet is Ultra-High Level under the NDPC's 2024 Guidance Notice (Schedule 7 to GAID 2025) = **₦250,000**, plus an annual Compliance Audit Return filed through a licensed DPCO before 31 March. Penalties are ₦2m–₦10m or 2% of gross revenue, whichever is greater.

## Regulatory guardrails (Aug 2026)

- **ISA 2025** makes digital assets securities; fiat↔crypto conversion = licensed VASP
  activity. 14 ARIP approval-in-principle holders incl. Quidax, Busha, Luno, Yellow Card.
  Minimum capital ₦300M–₦2B (Circular 26-1) — partnering is economically forced, and legal.
- **Veil's posture**: self-custody wallet software (the "on behalf of others" hinge keeps
  it outside VASP scope — the one item needing counsel confirmation); Busha does
  conversion under its licence; unauthorized conversion = ₦10–20M penalties.
- **KYC**: BVN or NIN is mandatory for every per-user virtual account (CBN tiered KYC;
  Tier 1 = BVN *or* NIN ≈ ₦300k limits; Tier 2 = both). The ₦-Receive flow needs a
  BVN/NIN capture step. "Invisible" can't mean "anonymous" on the fiat leg.
- **Bills**: route through licensed aggregators (Monnify/eBills) — their NCC/NERC
  licences cover the vend; reseller-needs-no-licence is the working assumption (inference,
  not verified rule).
- **July 2026 Executive Order**: payments-style stablecoin flows may migrate toward CBN
  jurisdiction — watch.

## Decided sequencing — bills first, offramp gated (2026-08-26)

**The two halves of this document carry very different regulatory weight, and we are shipping them separately.**

| Half | Posture | Status |
|---|---|---|
| **Spend crypto on airtime / data / bills** | The aggregator holds the NCC/NERC licence and the vend runs under it. We are a reseller buying a product, closer to merchant acceptance than to intermediation. `reseller-needs-no-licence` remains an **inference, not a verified rule** — but it is the same posture other Nigerian crypto-bills platforms already operate under | **Build now** |
| **Crypto → naira in a user's bank account** | The *arranging* limb of ISA 2025 Sch.2 Pt.II ¶2, no exclusions schedule, s.61 criminal liability. Self-custody does not help here | **Gated** on the SEC letter or the CBN sandbox |

All the weight in "The licensing question" above attaches to the **second** row. Nothing in this document says a reseller buying airtime needs a VASP registration.

### The constraint that keeps this safe

**Closed internal testing only — the team and an invited tester group. No public availability, no marketing, no promotion, no waitlist copy implying a live bills product.**

That last point is not cosmetic. The SEC's 14 May 2026 notice expressly reaches **promotion**, and promotion is what got Chaka restrained — it held no assets and executed nothing. A closed group testing a build is a materially different fact pattern from a marketed consumer service, and the difference is worth preserving deliberately.

### Why it is worth doing anyway

The SCF application currently has to describe the naira story rather than show it. A working airtime or data purchase, paid from a passkey smart wallet, settled in USDC on Stellar, is a demonstrable end-to-end claim in a way that a mock is not.

### What it is not

**Not a revenue line.** Verified first-hand: median margin is **1%** on MTN and Airtel, and every MTN and Airtel SME plan is currently `Unavailable` — the tiers that carry Nigerian volume cannot be sold at any margin. Glo SME is the only 10% inventory and Glo is a distant third by subscriber share. Bills is a **retention feature**. No model may assume otherwise.

### First blocker

**The eBills "reseller role"** — transactional endpoints require it, and how it is granted is behind the login wall. Thirty minutes of clicking settles it and nothing else starts until it does.

### UI consequence, already shipped

The dashboard `Pay for` grid used to render eight tiles, none of which did anything — `PayForGrid` was mounted with no `onSelect` at all. Each service now carries `status: 'live' | 'soon'`; the dashboard renders only `live` ones and hides the card entirely when there are none, while everything unshipped is listed in `ServicesDrawer` behind a "soon" badge, opened from the drape mark in the header. A service moves onto the dashboard by flipping one field.

## Phased build

**Adapter design rule (settled by the bills research):** the `BillsProvider` interface must be built around **"requery by *our* reference"**. eBills, Monnify and Plustive all support it; Pairgate does not — so Pairgate becomes the single implementation that has to persist a `reference → reference_code` mapping, instead of its weaker model leaking into the core interface.

**Phase 0 — testnet, no partner (start now):**
naira Receive tab shows a bank-account panel (mock number) + "deposits become dollars
automatically"; a dev webhook simulates the deposit → credits testnet USDC to the smart
wallet; bill tiles run against a sandbox (Pairgate `/test` or Plustive). Proves the entire
UX; this is the SCF demo.

**Phase 1 — paperwork (parallel):** CAC registration as a **Limited company, not a Business
Name** (a sole proprietorship is legally incapable of holding VASP status, so it cannot serve
this use case at any price). CAC incorporation is ~₦17,500 statutory at ₦1m issued share
capital (₦10,000 per additional ₦1m under the schedule effective 1 Aug 2025, plus 0.75% stamp
duty and ₦500 name reservation); CAMA 2020 s.18 allows a single person to form and direct a
small company. Then Busha Business KYB; Monnify account + bills activation email; eBills
tier-2 (BVN); **NDPC registration at Ultra-High Level (₦250,000)**.

⚠️ **But do not treat CAC as the thing that unlocks a live offramp** — see "The licensing
question" above. Incorporation is necessary and nowhere near sufficient; the SEC letter and
the CBN sandbox are the real gates, and the July 2026 Executive Order may move the whole
question to the CBN. **Send the SEC email before spending money on registration**, because
the answer changes which entity and which capital base we need.

**Phase 2 — live rails:** `OnrampProvider` + `BillsProvider` adapter interfaces (never
couple money-in and bill-delivery); Busha adapter (webhook → quote → USDC-XLM payout to
user C-address **with memo**), Monnify bills adapter with eBills fallback; float
dashboards for the two prefunded wallets.

## Open items

**Needs a human with a login (cannot be desk-researched):**
- ~~**eBills "reseller role"**~~ — **SETTLED 2026-08-26: the role is gated on funding the eBills wallet.** Probed directly: `/jwt-auth/v1/token` authenticates fine on an unfunded account, `GET /api/v2/balance` returns `403 rest_forbidden`. So the role is not a support request or a form — it is a deposit. **This is now a money blocker, not a paperwork one**, and the airtime build is parked until there is float to fund. Probe kept at `scripts/ebills-probe.mjs`; re-run it after funding to confirm.
- **eBills duplicate semantics** — does replaying a `request_id` after the 3-minute `duplicate_order` window create a **second vend**? Ask support before any retry logic ships.
- **eBills margins on a funded account** — confirm the live 1%-median finding before any revenue model depends on it.
- **eBills top-up mechanism** — undocumented publicly.

**Emails to send now (weeks of lead time, none block the eBills build):**
- **Monnify** — bills activation request, and whether the community-reported "Starter Business" (no-CAC) path is real.
- **Plustive** (`contact@plustiveimpact.com`) — do they onboard an unregistered sole developer, is there any test credential, and which static egress IPs do they need.

**Still open from the first pass:**
- Busha: confirm Stellar **memo** handling on USDC-XLM withdrawals + webhook latency (sandbox).
- SEC non-custodial-wallet exemption wording — Nigerian counsel.
- Monnify vend field names (`amount`/`reference` vs `vendAmount`/`vendReference`) — confirm against sandbox; send both pairs until then.
- Pairgate IP allowlisting — marketed as mandatory, absent from the auth docs, no error code exists.
- Load-test whichever rail gets real float.
