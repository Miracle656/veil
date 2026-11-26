# Wave batch 14 — Invest rail: tokenized real-world assets (DRAFT)

**Source:** research on 2026-09-23 into putting stocks on Stellar without Veil handling KYC. **Repo:** `Miracle656/veil`. **IDs:** V176–V190 (batch 13 ended at V175). **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** create the `epic:invest` label.

## What this batch is, and what it is not

There are **no tokenized stocks on Stellar today**. The two real equity platforms — Backed's **xStocks** and **Ondo Global Markets** — issue on Solana, Ethereum and BNB Chain, not Stellar. DTCC has announced tokenized Russell 1000 equities, ETFs and Treasuries on Stellar under a three-year SEC no-action letter, targeting **the first half of 2027**. So an equities rail is a 2027 conversation.

What *is* live on Stellar, verified on the public ledger on 2026-09-23:

| Asset | Issuer | Holders | Supply | `auth_required` |
|---|---|---|---|---|
| **USDY** (Ondo — US Treasuries, yield-bearing) | `GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6` | 2,997 | ~461.6M | **false** |
| **BENJI** (Franklin Templeton money market fund) | `GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5` | 1,369 | ~427.5M | **true** |

`auth_required = false` on USDY is the whole point of this batch: **any wallet can hold it without asking anyone's permission, so Veil performs no KYC and stores no identity documents.** BENJI's `auth_required = true` means its issuer must approve every trustline, which is an onboarding relationship Veil does not have — so BENJI is out of scope here, and the same mechanism is what DTCC equities will almost certainly use.

So this batch ships **the invest rail Stellar actually supports today** (a yield-bearing Treasuries asset), and builds the two pieces an equities rail will need in 2027 anyway: **verified asset identity** and **support for permissioned assets (SEP-8)**.

## Ground rules for every issue here

- **Pin assets by issuer, never by code.** USDY and BENJI both have impostor issuers on mainnet right now (`2pacdrop.com`, `native-rwa.com`, lookalike `lobstr.space` / `scopuly.pro` domains). A code match is not an asset match.
- **Veil never collects KYC**, never stores identity documents, and never becomes the counterparty. Where an asset requires approval, the issuer or anchor does it in their own flow.
- **No investment advice, no yield promises, no "returns" language.** Show what the asset is, what it costs, and who issues it.
- **Nothing in this batch enables an asset for a country before the legal question for that country is answered.** V190 is the gate; treat it as blocking, not optional.
- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.

---

### V176 · A verified asset registry, pinned by issuer

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:invest

### Background
The wallet identifies assets by code. On mainnet today, `USDY` resolves to at least twenty issuers and `BENJI` to twenty more, most of them impostors — one fake `EURC` even publishes a `blackrock.com.se` domain. A user who taps "USDY" must get Ondo's USDY and nothing else.

### What to build
- One registry module, shared by web and mobile, mapping a short key (`USDY`) to `{ code, issuer, name, issuerName, homeDomain, network, kind: 'treasury' | 'fund' | 'equity' | 'stablecoin' }`.
- Every balance row, picker and quote resolves through the registry. An asset that is not in it renders as "Unverified: CODE (issuer GABC…)" and never as the bare code.
- Verify the issuer's `stellar.toml` home domain matches the registry entry at build time, with a script that fails CI on a mismatch.

### Key files
- `frontend/wallet/lib/assets.ts` (new), `frontend/mobile/lib/assets.ts` (new)
- `scripts/verify-asset-registry.mjs` (new)

### Acceptance criteria
- [ ] Registry holds USDC, XLM, EURC, AQUA and USDY with exact issuers
- [ ] An asset whose issuer is not registered is labelled unverified everywhere it appears
- [ ] The CI script fails when a registry entry's home domain does not match its issuer's `stellar.toml`
- [ ] Unit tests cover a lookalike issuer with a registered code

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V177 · Hide unknown assets that impersonate a registered one

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:easy, epic:invest

### Background
Anyone can airdrop an asset into a Stellar account, and scam issuers deliberately reuse well-known codes. A tester already received unsolicited claimable balances on mainnet. Once an invest rail exists, "USDY" in a balance list has to mean Ondo's USDY.

### What to build
- Group balances into **Verified** and **Unverified** sections, unverified collapsed by default with a count.
- An unverified asset whose code matches a registered one is marked as impersonating it, naming the registered issuer.
- Never auto-hide silently: the user can expand and see everything they hold.

### Key files
- `frontend/mobile/app/(tabs)/dashboard.tsx`, `frontend/mobile/app/assets.tsx`, the web dashboard

### Acceptance criteria
- [ ] Verified assets appear first; unverified are collapsed with a count
- [ ] A code collision is called out explicitly in the row
- [ ] Nothing is hidden irrecoverably
- [ ] Tests cover a wallet holding both real and impostor USDY

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V178 · Add USDY: trustline, balance and price

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:invest

### Background
USDY is Ondo's US Treasuries-backed, yield-bearing token. It is live on Stellar with `auth_required = false`, so a wallet can hold it with no permission from anyone. Holding it needs a trustline, which costs 0.5 XLM of reserve.

### What to build
- Add USDY through the registry (V176) with a one-tap "Enable USDY" that creates the trustline, stating the 0.5 XLM reserve up front.
- Show the balance in USDY and its value in USD, priced through the existing quote path.
- Handle the no-trustline and insufficient-reserve cases with plain sentences, not raw errors.

### Key files
- `frontend/mobile/lib/enableUsdc.ts` (generalise, do not copy), `frontend/mobile/app/assets.tsx`, web equivalents

### Acceptance criteria
- [ ] Enabling USDY creates exactly the right trustline (issuer verified against the registry)
- [ ] The reserve cost is shown before the user commits
- [ ] Balance and USD value render for a funded account on mainnet — include a testnet or mainnet transaction hash in the PR
- [ ] Tests cover missing trustline and too little XLM for the reserve

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V179 · Buy and sell USDY with USDC, with the spread shown honestly

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:advanced, epic:invest

### Background
On 2026-09-23 the USDY/USDC order book was thin: a best bid of 1.0820 against a best ask of 1.1445, about a 5.8% spread, with only a few hundred USDY resting on each side. A user who buys and immediately sells loses that spread. Hiding it would be the dishonest way to ship this.

### What to build
- Buy and sell USDY for USDC through the existing Swap path (Soroswap aggregator, falling back to the DEX).
- Before confirming, show the price, the spread against the opposite side of the book, the price impact for that size, and what the user would get back if they sold immediately.
- Refuse sizes the book cannot fill without a price impact over a set threshold, and say why.

### Key files
- `frontend/mobile/lib/soroswap.ts`, `frontend/mobile/app/swap.tsx`, web swap page

### Acceptance criteria
- [ ] Buy and sell both work on mainnet — transaction hashes in the PR
- [ ] Spread and price impact are shown before confirmation, not after
- [ ] An order that would move the price beyond the threshold is refused with a clear reason
- [ ] Tests cover a thin book and an empty book

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V180 · Explain what USDY is, in one screen

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:easy, epic:invest

### Background
A user seeing "USDY" in a wallet has no idea what they hold. It is a token backed by short-term US Treasuries and bank deposits, issued by Ondo, whose value per token rises as interest accrues — it does not pay out separately, and it is not a bank deposit or a savings account.

### What to build
- An asset detail screen: what it is, who issues it (with a link to their disclosures), how its value accrues, what can go wrong (issuer risk, thin liquidity, price can fall), and that it is not insured.
- Plain language, no "returns", "profit" or "guaranteed" anywhere.
- Reachable from the balance row and from the buy flow.

### Acceptance criteria
- [ ] The screen names the issuer and links to their own disclosures
- [ ] Risks stated before any buy button appears
- [ ] Copy reviewed for advice-like language — list the words avoided in the PR

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V181 · Show yield as it actually works: price accrual, not payouts

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:invest

### Background
USDY's token count does not grow; its price does. A balance screen that shows only "100.00 USDY" hides the entire point, and a naive "earnings" figure would be wrong.

### What to build
- Track the user's cost basis per asset locally (what they paid, in USDC).
- Show current value, change since purchase in USDC and percent, and the period covered.
- Label it "change in value", never "earnings" or "interest earned", and never annualise from a short window.

### Acceptance criteria
- [ ] Cost basis survives restarts and is per asset
- [ ] A user who bought at several prices sees a correct weighted basis
- [ ] Losses render as losses, in the same terms as gains
- [ ] Unit tests cover multiple buys, a partial sell, and a price fall

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V182 · An Invest section in Earn, alongside the lending pools

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:invest

### Background
Earn currently means Blend lending. Treasuries are a different thing with a different risk profile, and the two should not be presented as one list of "yields".

### What to build
- Two sections in Earn: **Lending** (Blend, as today) and **Invest** (tokenized assets, starting with USDY).
- Each card states the issuer, what backs the asset, and the risk in one line.
- The Invest section is empty-stated when no invest asset is enabled for the user's region (see V190).

### Key files
- `frontend/mobile/app/(tabs)/earn.tsx`

### Acceptance criteria
- [ ] Lending and Invest are visually distinct, with no combined "APY" comparison between them
- [ ] Each card names the issuer
- [ ] The section hides cleanly when nothing is available

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V183 · Support permissioned assets (SEP-8), for what comes in 2027

**Labels:** help wanted, Stellar Wave, area:wallet, area:sdk, difficulty:advanced, epic:invest

### Background
BENJI sets `auth_required = true`: its issuer must authorise every trustline. Tokenized equities will almost certainly work the same way, and DTCC's assets are expected on Stellar in the first half of 2027. SEP-8 is the standard flow — the wallet submits a transaction to the issuer's approval server, which returns it signed, revised, or rejected with a reason.

### What to build
- A SEP-8 client in the SDK: submit, handle `success` / `revised` / `pending` / `action_required` / `rejected`, and surface the issuer's own message.
- The wallet shows an asset that needs approval as "Requires approval from {issuer}", with the issuer's flow opened in a browser — **Veil collects nothing**.
- Documented, with a testnet regulated asset in the test suite.

### Acceptance criteria
- [ ] All five SEP-8 outcomes handled, each with a test
- [ ] A revised transaction is re-verified locally before the user is asked to sign it — never signed blind
- [ ] No identity data passes through Veil's code or storage
- [ ] Documented in `frontend/docs`

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V184 · Anchor directory: discover invest assets via SEP-1 and SEP-6/24

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:advanced, epic:invest

### Background
When an equities issuer does arrive, it will publish a `stellar.toml` and, usually, a SEP-24 hosted deposit flow. Veil should be able to list and open those without a code change per issuer — and the hosted flow is exactly what keeps KYC with the anchor.

### What to build
- Read an issuer's `stellar.toml` (SEP-1) for currencies and endpoints; list assets it offers.
- Where the issuer supports SEP-24, open its hosted deposit or withdraw page in a browser, authenticated with SEP-10 using the user's own key.
- Nothing about the user is sent anywhere by Veil beyond the SEP-10 challenge signature.

### Acceptance criteria
- [ ] A SEP-1 TOML is parsed and its currencies listed, with issuer verification
- [ ] SEP-10 authentication works against a testnet anchor
- [ ] The SEP-24 flow opens and returns to the wallet cleanly
- [ ] A malformed or hostile TOML cannot inject an asset into the verified registry

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V185 · Trustline reserve, explained before it is spent

**Labels:** help wanted, Stellar Wave, area:mobile, area:wallet, difficulty:easy, epic:invest

### Background
Every new asset locks 0.5 XLM. A user enabling three assets loses 1.5 XLM of spendable balance with no explanation, and then cannot understand why their XLM "went down".

### What to build
- Before enabling any asset, show what the reserve costs and what the remaining spendable XLM will be.
- In settings, list trustlines with their locked reserve and offer to remove an empty one, which returns the reserve.

### Acceptance criteria
- [ ] Reserve cost and resulting spendable balance shown before confirmation
- [ ] Removing an empty trustline returns 0.5 XLM — transaction hash in the PR
- [ ] Removal is refused, with a reason, when the balance is not zero

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V186 · Agent: answer questions about invest assets, and hand buys to the screen

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:intermediate, epic:invest

### Background
The agent already prices assets and hands swaps to the Swap screen rather than building them itself. Invest assets should work the same way: it can explain and quote, but a purchase is reviewed and signed on a screen built for it.

### What to build
- The agent can answer "what is USDY", "what is it worth", "what do I hold" from the registry and on-chain data.
- "Buy 50 USDC of USDY" produces a hand-off to the invest screen, pre-filled; the agent never builds the transaction.
- It states the issuer and the risk line in its answer, and gives no advice on whether to buy.

### Key files
- `packages/agent/src/agent.ts`, `packages/agent/src/price.ts`

### Acceptance criteria
- [ ] Explain, quote and hold questions answered without an LLM inventing numbers
- [ ] A buy request returns a hand-off, never a transaction
- [ ] Tests cover the hand-off and a refusal to advise

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V187 · Portfolio view: what you hold, across cash and invest assets

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:invest

### Background
Once a wallet holds USDC, XLM and an invest asset, "how much do I have" needs one answer, split by kind.

### What to build
- A portfolio summary: total value in USD (and the user's local currency where already supported), split into cash, lending positions and invest assets.
- Each line shows the asset, its value and its share of the total.
- Values are computed from live quotes, with the "priced at" time shown.

### Acceptance criteria
- [ ] Totals match the sum of the parts, to the displayed precision
- [ ] A stale or failed quote shows as unavailable rather than zero
- [ ] Tests cover a missing price and an empty portfolio

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V188 · Asset metadata and logos from the issuer's own TOML

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:easy, epic:invest

### Background
Registry entries carry names, but issuers publish their own metadata — display name, description, logo — in `stellar.toml`. Fetching it keeps the wallet current without a release, as long as it is fetched for registered issuers only.

### What to build
- Fetch and cache TOML currency metadata for registered assets, refreshed daily.
- Never fetch metadata for unverified assets, and never let fetched text replace the verified issuer name.
- Images: size-limited, HTTPS only, failure falls back to a letter avatar.

### Acceptance criteria
- [ ] Metadata cached with an expiry, and used only for registered issuers
- [ ] An oversized or non-HTTPS image is rejected
- [ ] Offline falls back cleanly

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V189 · Document the invest rail, including what Veil is not

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:invest

### Background
The invest rail invites the question "is Veil a broker?". The answer must be written down, publicly and precisely: Veil is a self-custody wallet through which a user can hold assets issued by third parties, and it never takes custody, never performs KYC and never gives advice.

### What to build
- A docs page covering: what tokenized Treasuries are, who issues them, what Veil does and does not do, what happens if the issuer fails, and where assets are not offered.
- Link it from the invest screens.

### Acceptance criteria
- [ ] The page states plainly that Veil does not take custody, does not perform KYC and does not advise
- [ ] Issuer risk and liquidity risk described in plain language
- [ ] Linked from the app

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V190 · Eligibility gate — blocking, and required before any of this ships

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:invest

### Background
Tokenized Treasuries are financial instruments, and offering them to residents of a given country is a regulated activity in many places — including Nigeria, where the position on arranging investment transactions is exactly the open question recorded in `docs/NGN_RAILS.md`. Ondo itself restricts US persons from USDY. **Every other issue in this batch is dark behind this one.**

### What to build
- A per-asset availability config: which regions an asset may be offered in, defaulting to **offered nowhere** until explicitly enabled.
- An eligibility acknowledgement before first purchase: what the asset is, who may hold it, and a declaration the user is not in an excluded category.
- A feature flag so the invest rail can be switched off entirely in one place.

### Acceptance criteria
- [ ] Default configuration offers no invest asset in any region
- [ ] Enabling a region for an asset is one reviewed change, not a runtime toggle
- [ ] The acknowledgement is recorded locally with a timestamp and the asset it covered
- [ ] Tests cover the default-off state and an excluded region

> **Drips Wave** · Complexity: **Intermediate** · **150 points**
