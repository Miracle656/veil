# Wave batch 21 — sovereign debt that needs nobody's permission (DRAFT)

**Repo:** `Miracle656/veil`. **IDs:** V253–V258 (batch 20 ended at V252). **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** create the `epic:invest` label if batch 14 has not already.

## Why this batch exists

Batch 14 built the invest rail around a single asset, USDY, because it was the one tokenized real-world asset on Stellar that any wallet could hold without asking an issuer's permission. That rail works. This batch widens it, because USDY is no longer the only one.

Stellar leads every chain in RWA growth right now, but almost all of that number is **permissioned**. Franklin Templeton's BENJI — the single largest piece of it — is `auth_required`, `auth_revocable` and `auth_clawback_enabled`, and on mainnet today it has **1,375 authorized trustlines and 992 unauthorized ones**. Four in ten people who tried to hold it added the trustline and were never approved. Adding a BENJI button to Veil would mostly manufacture more of those.

Etherfuse is the exception, and it is a family rather than a single asset: six tokenized sovereign bonds issued natively on Stellar, every one of them with **no authorization flags at all**. Their primary market is explicitly **non-US investors**, which is Veil's users rather than an obstacle to them. Three of the six have real two-sided order books against USDC today.

So this batch does one thing: make those three buyable, hold the line on the three that are not, and reuse everything batch 14 already built rather than growing a second invest rail beside it.

## Shared with every issue

### Verified on the public ledger and at the issuer's own domain, 2026-10-05

**One issuer publishes all six:** `GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC`

Verified in **both** directions, which only one asset in the registry (AQUA) currently manages:

- The issuer account's Horizon `home_domain` is `etherfuse.com`.
- `https://etherfuse.com/.well-known/stellar.toml` returns HTTP 200 and declares every code against that exact issuer, under `ORG_NAME = "Etherfuse"`.

So `scripts/verify-asset-registry.mjs` passes on these as written. Do not weaken it to accommodate them.

| Code | What it is | Flags | Trustlines | Supply | USDC book |
|---|---|---|---|---|---|
| **CETES** | Mexican treasury (Certificados de la Tesorería) | none set | 1,168 | 40,692,955 | 20 bids / 13 asks, spread **0.05%** |
| **USTRY** | US Treasury notes | none set | 930 | 10,441,784 | 16 bids / 10 asks, spread **0.05%** |
| **TESOURO** | Brazilian treasury | none set | 194 | 1,772,405 | 20 bids / 7 asks, spread **0.05%** |
| KTB | Korean treasury | none set | 46 | 102 | **1 bid, 0 asks** |
| EUROB | Eurobonds | none set | 32 | 1.5 | **1 bid, 0 asks** |
| GILTS | UK gilts | none set | 15 | 1.7 | **1 bid, 0 asks** |

"Flags: none set" means `auth_required=false`, `auth_revocable=false`, `auth_clawback_enabled=false`. Nobody can freeze or claw these back, and nobody has to approve a trustline.

The `stellar.toml` carries per-currency metadata the UI should use rather than invent — `name`, `desc`, `image`, `is_asset_anchored = true`, `anchor_asset_type = "bond"`, and `anchor_asset` (e.g. `"US Treasury Notes"` for USTRY).

### The thing that will bite you first

**These codes are longer than four characters.** Every asset in `ASSET_REGISTRY` today — USDC, EURC, AQUA, USDY, USDT0 — is `credit_alphanum4`. `CETES`, `USTRY` and `TESOURO` are `credit_alphanum12`. That changes the `asset_type` in every Horizon query, order-book lookup and path-payment call. A hardcoded `credit_alphanum4` returns an empty book rather than an error, which looks exactly like "no liquidity".

### Where the existing work is

- `frontend/mobile/lib/assets.ts` and `frontend/wallet/lib/assets.ts` hold `ASSET_REGISTRY` and `RegisteredAsset`. They are kept identical by `frontend/mobile/lib/__tests__/registryParity.test.ts` — change one, change both.
- `scripts/verify-asset-registry.mjs` runs in CI and fails on an issuer whose `stellar.toml` does not declare the exact `code:issuer` pair.
- Batch 14 (V176–V190) built the registry, the unverified-asset labelling, the Invest section, the USDY explainer and the price-accrual display. **Read those issues before starting.** This batch extends them; it does not replace them.

### Ground rules

- **Pin by issuer, never by code.** 23 issuers publish "BENJI" on mainnet and 200+ publish "USDC". A code match is not an asset match.
- **No investment advice, no yield promises, no "returns" language.** Show what the bond is, what it costs, who issues it, and that its price moves.
- **Never show an asset the user cannot sell.** A one-sided book is a trap, not a listing.
- **Veil collects no KYC and is never the counterparty.** These assets need none; that is the entire reason they are here.
- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.
- Mobile installs with plain `npm install`, never `--legacy-peer-deps`, and tests with jest via `jest-expo`.

---

### V253 · Register the three stablebonds that are actually tradeable

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:invest

### Background
`ASSET_REGISTRY` is how the wallet tells a real asset from an impostor. CETES, USTRY and TESOURO belong in it; KTB, EUROB and GILTS do not yet, and V258 covers why.

### What to build
- Registry entries for `CETES`, `USTRY` and `TESOURO`, all against `GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC`, with `homeDomain: 'etherfuse.com'` and `issuerName: 'Etherfuse'`.
- Widen `RegisteredAsset['kind']` with a value that describes sovereign debt. `treasury` already means USDY; a bond backed by a named government is a different thing to a tokenized Treasuries fund, and the explainer screens read this field.
- Each entry records which government's debt it is, so the UI never has to parse it out of a name.
- Add the same entries to both `frontend/wallet/lib/assets.ts` and `frontend/mobile/lib/assets.ts`, identically.

### Key files
- `frontend/wallet/lib/assets.ts`, `frontend/mobile/lib/assets.ts`
- `frontend/mobile/lib/__tests__/registryParity.test.ts`

### Acceptance criteria
- [ ] `node scripts/verify-asset-registry.mjs` passes with the three new entries and is not modified to make them pass
- [ ] The parity test passes — the two files agree exactly
- [ ] A lookalike issuer publishing code `CETES` resolves as unverified, with a test covering it
- [ ] Registering these does not change how any existing asset renders

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V254 · Make a twelve-character asset code work everywhere

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:invest

### Background
Every registered asset today is four characters or fewer. `CETES`, `USTRY` and `TESOURO` are not, and Stellar treats the two lengths as different asset types. Anywhere the code assumes `credit_alphanum4`, these assets will silently resolve to nothing — an empty order book, a balance that never appears, a trustline that cannot be built.

### What to build
- Find every place the asset type is decided and derive it from the code's length rather than assuming. Horizon queries, order-book lookups, path payments, trustline (`changeTrust`) building, and anywhere a balance row is matched against the registry.
- Trustline creation, balance display and price lookup all working for a five- and a seven-character code.
- The reserve cost of a trustline is the same for both; do not let a longer code imply a different `reserveXlm`.

### Acceptance criteria
- [ ] A trustline for `TESOURO` can be created from both web and mobile
- [ ] The balance appears in the asset list, named from the registry, after the trustline exists
- [ ] A price quote resolves for all three codes
- [ ] Tests cover a 4-, 5- and 7-character code through whatever helper decides the asset type
- [ ] No existing 4-character asset changes behaviour

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V255 · Buy and sell a stablebond with USDC

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:advanced, epic:invest

### Background
All three tradeable bonds have two-sided books against USDC with spreads around 0.05%. The swap screen already quotes and executes against the DEX; this is about making these assets reachable through it honestly, including when they are not.

### What to build
- CETES, USTRY and TESOURO selectable in the swap flow, quoted against USDC in both directions.
- The quote shows the real spread, from the live book, not a mid price presented as a fill.
- A trustline the user does not have yet is part of the flow, with its XLM reserve cost stated before they commit — not a failure after they tap.
- An order book that cannot fill the requested size says so, with the size that *can* fill. These books are real but thin: 10 asks is not infinite depth.

### Acceptance criteria
- [ ] A buy and a sell both complete on mainnet, and the PR states the transaction hashes
- [ ] The quote matches the live book at the time it is shown; a stale quote is re-fetched rather than executed
- [ ] A size larger than the book can fill is refused with a usable number, not a failed transaction
- [ ] Missing trustline is handled before signing, with the reserve cost shown
- [ ] Tests cover the thin-book and missing-trustline paths

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V256 · One screen that explains what a stablebond is

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:easy, epic:invest

### Background
"CETES" means nothing to someone in Lagos, and "Certificados de la Tesorería de la Federación" means less. Someone about to put money into Mexican government debt should be told that is what they are doing, in a sentence, before they do it.

### What to build
- A per-asset explainer reachable from the asset row and from the buy flow, following the shape of the USDY explainer built in V180.
- For each bond: whose debt it is, who issues the token, that its price moves rather than paying out, and that Veil is not the counterparty.
- Use the issuer's own `stellar.toml` metadata (`desc`, `anchor_asset`, `anchor_asset_type`, `image`) rather than copy writing invented in the PR.
- No yield figure, no projection, no "returns". State that the price has moved and let the price say by how much.

### Acceptance criteria
- [ ] Each of the three assets has an explainer naming the issuing government and the token issuer
- [ ] Copy contains no promise, projection or advice — a reviewer can check this by reading it
- [ ] Content comes from the registry and the issuer's TOML, not hardcoded prose per asset
- [ ] The screen renders correctly with a missing or unreachable TOML

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V257 · Show the gain as price accrual, because that is what it is

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:invest

### Background
USTRY trades at about 1.076 USDC against an issue price of 1. Nothing was ever paid out; the token itself is worth more. V181 built exactly this display for USDY, including a cost basis. The bonds need the same treatment, and the same refusal to call it "earnings".

### What to build
- Reuse the V181 cost-basis mechanism rather than writing a second one. If it is not currently shared between the two clients, this is the issue to share it in.
- Show, per holding: what it cost, what it is worth now, and the difference — as a value, not as a rate.
- Never annualise. A number like "7.6%" implies a forward rate nobody has promised.
- A holding with no recorded cost basis shows its current value and says the gain is unknown, rather than assuming the purchase price was 1.

### Acceptance criteria
- [ ] Gain is derived from a recorded cost basis, never from an assumed issue price
- [ ] No annualised or projected rate appears anywhere in the display
- [ ] A holding acquired before cost basis was recorded degrades to "value only" with a plain explanation
- [ ] Tests cover a gain, a loss, and an unknown basis

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V258 · Never list a bond you cannot sell

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:invest

### Background
KTB, EUROB and GILTS are real assets from the same verified issuer, with the same absence of authorization flags. They also have **one bid and no asks** between them. A user who bought one would hold something with no way out. That is the single worst outcome this rail can produce, and the registry alone cannot prevent it — liquidity is a live property, not a static fact.

### What to build
- A liquidity check an asset must pass before it is offered for purchase: a two-sided book, with depth, measured live rather than assumed.
- An asset that fails it is **not hidden** — it may still be held, displayed and sold — it simply cannot be bought through Veil, and says why in one sentence.
- The three currently-tradeable bonds pass; the three thin ones do not, today, without a code change when that stops being true.
- The threshold is a named constant with a comment explaining what it is protecting against, not a magic number.

### Key files
- Wherever V255 builds the buy path; the check belongs in front of it, shared by web and mobile.

### Acceptance criteria
- [ ] An asset with a one-sided book cannot be bought, and the reason shown names illiquidity rather than an error
- [ ] The same asset can still be sold and still appears in balances
- [ ] CETES, USTRY and TESOURO pass the check against the live books
- [ ] The check survives a Horizon failure by refusing the buy, not by allowing it
- [ ] Tests cover one-sided, empty and healthy books

> **Drips Wave** · Complexity: **Intermediate** · **150 points**
