IyBDb250cmFjdHMgdjIg4oCUIHRoZSB1cGdyYWRlYWJpbGl0eSBnYXAsIGFuZCB0aGUgcGxhbiBiZWZvcmUgU0NGCg==

**Status:** open · **Found:** 2026-09-13 · **Target:** before the SCF Build Award submission (SCF #46, deadline 2026-11-08 — confirm the round live before submitting)

This records a gap found while answering "can one passkey own multiple wallets?", how it
got past us, what it means for mainnet, and the work that closes it. Keep the checklists
current: this file is what gets read back when the reminder comes round.

---

## 1. The finding

**No Veil contract can be upgraded.** Soroban supports it — a contract can replace its own
code in place, keeping its address and storage, via
`env.deployer().update_current_contract_wasm(new_wasm_hash)` exposed through a function the
contract defines. We never wrote that function, anywhere.

Evidence, reproducible from the repo:

| Check | Result |
|---|---|
| `grep -rn "update_current_contract_wasm\|fn upgrade" contracts --include=*.rs` | **no matches** |
| Factory public functions (`contracts/factory/src/lib.rs`) | `__constructor(admin)`, `init(wasm_hash)`, `deploy(public_key, rp_id, origin)` — nothing else |
| `init` | sets the wallet Wasm hash **once**; a second call fails `AlreadyInitialized` |
| Wallet salt in `deploy` | `SHA-256(public_key)` only; a second deploy for the same key fails `AlreadyDeployed` |

**Our own docs say otherwise.** `frontend/docs/pages/contract-upgrades.mdx` — live on
docs.useveilapp.xyz — documents two upgrade paths:

| Documented | Exists |
|---|---|
| Factory `set_wasm_hash` (new wallets use new code) | ❌ |
| Wallet `upgrade(new_wasm_hash)` via `update_current_contract_wasm` | ❌ |

## 2. What it means

- **The mainnet factory is permanent.** `CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK`
  will deploy the wallet code it was initialised with (`b485f817…`) for as long as the apps point at it.
- **Every wallet already on mainnet runs that code forever.** A bug fix in the wallet contract
  reaches only wallets deployed afterwards, from a new factory. Existing users would have to
  move their funds.
- **The latent spend-limit defect cannot be patched in place.** `__check_auth` sums argument 2
  of every contract call regardless of asset, so one cap means 10 XLM or 10 USDC depending on
  what moves (~9× overspend in USDC terms). Unreachable today — `set_key_spend_limit` is called
  from nowhere — but no existing wallet can ever receive the fix.
  **Fixed in the contract, for new wallets only.** The limit is now keyed per
  `(key_id, token contract)`, each pair with its own cap, total and 24-hour window. A wallet
  already deployed on the old factory keeps the old asset-blind code forever: the fix reaches
  it only when its owner opens a wallet from the new factory and moves the balance across.
- **One passkey = one wallet per network**, fixed by the salt. Changing that needs a new factory.
- **A new factory means new addresses for everyone.** The factory's own address is part of
  every wallet address (`HashIdPreimage::ContractId { networkId, factory, salt }`). A new
  factory can keep the *formula* — wallet 0 still salted with `SHA-256(public_key)` — but not
  the *addresses*. Wallets on the old factory stay where they are.

## 3. How it got past us

1. **The page arrived as a contributor docs PR.** Added in `5c923e7` (Wave PR #332,
   2026-06-25). Written as a procedure for functions that did not exist — the factory snippet
   is even labelled *"new function for operator-controlled upgrade"*, a proposal rendered as
   instructions.
2. **It was merged as documentation, in a batch sweep, without checking its claims against
   `contracts/`.** A page that confidently describes upgrades makes everyone assume they exist.
3. **No implementation issue was ever opened.** The Wave catalog has no upgrade issue, so the
   work was never on anyone's list.
4. **Nothing before mainnet asked the question.** Upgradeability is absent from the mainnet
   readiness notes, `docs/SCF_STRATEGY.md`, and the external security assessment. "Testnet
   Wasm == mainnet Wasm, deploy once" made a single immutable deployment feel finished
   rather than risky.

**Process fix:** a docs PR that describes contract behaviour must cite the function it
documents (file and name). Reviewers check the citation exists before merging.

## 4. Why it is not fatal for SCF

- **Now is the cheapest it will ever be.** Mainnet volume so far is our own verification
  transactions and a handful of testers. Migrating that is a small job; after launch it is a project.
- **A known gap with a plan reads better than one a reviewer finds.** Say it in the
  application, with v2 in the milestones.
- **It is squarely what the Integration Track ask is for:** mainnet hardening.

## 5. What a redeploy costs, and how to avoid paying for it now

Measured from the original mainnet deployment (deployer
`GDWBFMW565JIDKUQZMGPS6SHRLM7ZIFVVRKBPBJZPJG6EOJQ7LDK3YVX`, 2026-08-21), fees charged on chain:

| Transaction | Fee |
|---|---|
| Upload wallet contract Wasm | 33.3089239 XLM |
| Upload factory Wasm | 5.9505297 XLM |
| Create factory contract | 0.0309962 XLM |
| `init` | 0.0119811 XLM |
| **Total** | **≈ 39.30 XLM (≈ $7 at 1 XLM = 0.178 USDC, 2026-09-13)** |

The Wasm uploads are almost all of it. v2 changes both contracts, so expect about the same
again. It is small, but it is not zero, and there is no reason to spend it before the award:

1. **Build and prove v2 on testnet — free.** Friendbot pays; testnet fees cost nothing real.
   SCF #46 makes tranche 2 a testnet deliverable, so a tested v2 on testnet is exactly what
   that tranche asks for.
2. **Make the mainnet redeploy a funded milestone** in the application, with the ~40 XLM
   deploy and the tester migration costed in, instead of paying it out of pocket first.
3. **Do the free items now:** correct the public docs page, and disclose the gap and the plan
   in the application.

## 6. Contracts v2 — scope

> **Read §9 first.** It recommends building v2 on OpenZeppelin's audited smart accounts instead of our own contract; if adopted, most of this list becomes configuration rather than code.

One contract release: tested on testnet first (free), then one mainnet factory redeploy,
funded by the award.

- [ ] **Wallet `upgrade(new_wasm_hash)`, authorised only by that wallet's own signers**
      (`require_auth` on the wallet address, answered by `__check_auth`). **Never an operator
      key.** The current docs say to submit upgrades "using stellar CLI as operator" — building
      that would let whoever holds our admin key replace the code of every wallet and take the
      funds. That is the self-custody question reviewers will ask first.
- [ ] **Factory `set_wasm_hash(new_hash)`, admin-gated** (the admin is already fixed at
      construction). Affects only wallets deployed afterwards.
- [x] **Spend limits keyed per `(key_id, token contract)`** instead of one asset-blind sum.
      Shipped in the contract: each `(key, token)` pair carries its own cap, its own running
      total and its own rolling 24-hour window, and the amount is read per selector from the
      SEP-41 argument layout rather than from a fixed index. A key with no limits is
      unrestricted; a key with at least one limit is scoped to the tokens it has a budget for,
      and an unset token is **denied** rather than unlimited — the reasoning is in
      `contracts/invisible_wallet/src/policies/spend_limit.rs`. This reaches **new wallets
      only**: see the migration note in §2.
- [ ] **A batch entry point — `batch_execute(calls)` or a router — so one signature can cover
      many payments.** `execute(target, func, args)` (`contracts/invisible_wallet/src/lib.rs:450`)
      takes exactly one call, and a Soroban transaction carries one `InvokeHostFunction`, so N
      recipients means N signatures and N submissions. This is why #932 (V250, bulk payout) shipped
      with `MAX_ROWS_PER_TRANSACTION = 1`, paying row by row and saying so on screen: the feature's
      headline promise — *sign once, pay everyone* — is not implementable against the deployed
      contract. The fake-success bug is fixed; the capability is still missing, and it only arrives
      with a new factory. Whatever shape v2 takes, this is the one user-visible feature blocked
      purely by the contract.
- [ ] **Decide multi-wallet.** If yes: salt = `SHA-256(public_key ‖ index)`, with index 0
      defined as `SHA-256(public_key)` so the derivation formula is unchanged. Also needs a
      per-index fee-payer derivation (the PRF salt ends in `/v1`), index discovery on recovery
      (scan 0, 1, 2… to the first empty), and a wallet switcher on web and mobile. Ask users what
      they want it for first — separating savings may already be covered by the vault contract.
- [ ] Contract tests for all of the above, including: an operator key **cannot** upgrade a wallet.
- [ ] Reproducible build; update `contracts/expected-hashes.json` from the CI log.
- [ ] Deploy the new mainnet factory; update the factory id defaults in
      `frontend/mobile/lib/network.ts` and `frontend/wallet/lib/network.ts`, and any
      `*_FACTORY_CONTRACT_ID_MAINNET` env values.
- [ ] Migration for existing mainnet wallets: move balances from old wallet to new, with the
      app detecting an old-factory wallet and offering the move.
- [ ] Re-run the mainnet receipts (passkey spend, Soroswap swap) against the new factory and
      update `README.md` / `docs/SCF_STRATEGY.md`.

## 7. Do now — no contract work needed

- [x] **Correct `frontend/docs/pages/contract-upgrades.mdx`.** Mark both functions as *not
      implemented, planned for contracts v2*. It is public and describes guarantees we do not have.
- [ ] **SCF application:** state the gap and put contracts v2 in the milestones.

## 8. Other open items from mainnet testing (September 2026)

- [x] **Community APK built 2026-09-13** (versionCode 2, EAS build `0368e19f`), includes: `2370245` send balance per source, `6a4ba72`
      PIN-only lockout + balance error, `bafda2b` swap from smart wallet, `4937b83` all-asset
      balance card, `df0dea3` spending from an undeployed smart wallet, `e203ae3` payout
      provider not named, `4e07eac` Earn per-asset deposits + mainnet pool, `76fdd79`
      background payment notifications, and the send-screen spending balance. `autoIncrement`
      (remote versionCode) is now set on the community profile. Tester checks: Earn deposit of
      USDC held in the smart wallet, withdraw all, a payment notification with the app closed.
- [x] **Instant notifications** need server push (Expo push token + a sender watching mainnet);
      the background check is up to ~15 min and some Android battery managers skip it.
      **Done:** per-wallet Expo push token registration with explicit consent and a
      revoke path; a sender watching the wallet's addresses on mainnet; notification content
      is a setting, conservative by default (no amount on the lock screen); tokens and
      addresses are never logged where they can be correlated to a person; a revoked token
      stops receiving pushes. No contract change — the deployed contracts cannot be changed,
      so this ships entirely in the apps and the Wraith backend, and existing wallets that
      already hold money get it without moving funds.
- [ ] **Vercel:** set `NEXT_PUBLIC_NETWORK=mainnet` for Production only (keep `testnet` for
      Preview/Development), after `7566bdd` is the live deploy; redeploy without build cache.
- [ ] **Browser-test deploy-later on mainnet:** create with no XLM → dashboard; lock/unlock →
      same wallet; fund spending address → add a backup passkey → contract deploys on chain.
- [ ] **Confirm recovery breadcrumbs are written on mainnet** (two data entries on the
      fee-payer after the dashboard loads once).
- [ ] **Funder account** for community drops: ~2.6 XLM per person (`scripts/fund-receivers.mjs`).
- [ ] **No-PRF passkey providers** (e.g. Samsung Pass, a vivo tester 2026-09-15) create unrecoverable wallets. **Partly done:** the create screen now says why (unsupported manager / closed prompt / error) and offers a retry that binds recovery while the spending account is still unfunded. Still open: prompt at
      creation, not just a warning afterwards.
- [x] **QuickNode mainnet RPC is a trial** (cliff ~18 Sept 2026). Fixed in code: the proxy now fails over to free public RPCs (Lightsail, Gateway.fm, sorobanrpc.com, Ankr), all checked against the calls Veil makes. **Live only once this reaches `main` (Vercel production).** No APK rebuild needed; the app talks to the proxy.
- [ ] `/offramp/orders` on Wraith is unauthenticated.

## 9. Decision: build v2 on OpenZeppelin smart accounts

**Status:** recommended, not yet adopted · **Assessed:** 2026-09-22 against
`OpenZeppelin/stellar-contracts@a5bd8cb` (v0.7.1) and `stellar/smart-account-kit@9d22a96`.

Every finding in §6 needs a new con