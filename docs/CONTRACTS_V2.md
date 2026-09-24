# Contracts v2 — the upgradeability gap, and the plan before SCF

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
- [ ] **Spend limits keyed per `(key_id, token contract)`** instead of one asset-blind sum.
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

- [ ] **Correct `frontend/docs/pages/contract-upgrades.mdx`.** Mark both functions as *not
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
- [ ] **Instant notifications** need server push (Expo push token + a sender watching mainnet);
      the background check is up to ~15 min and some Android battery managers skip it.
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

Every finding in §6 needs a new contract anyway, and the old wallets can never be patched, so
this is the cheapest point to decide whether v2 should be *our* contract at all. The
alternative is OpenZeppelin's smart account (`packages/accounts`) — the contract SDF's own
`smart-account-kit` deploys, and which `passkey-kit` points to for rules and policies. Veil
would keep the product (apps, SDK, cash-out, yield, agent) and stop maintaining a wallet
contract.

### What was checked, and where

Read in source, not from READMEs: the WebAuthn verifier
(`packages/accounts/src/verifiers/webauthn.rs`), the smart account and its storage
(`smart_account/`), the spending-limit policy, the reference account contract
(`examples/multisig-smart-account/account`), and SAK's mainnet deployment manifest and
deployer security notes. Audit coverage from the PDFs in `audits/`: the smart account,
WebAuthn verifier and spending limit are covered by **four rounds** — v0.5.0, its re-audit,
v0.6.0 and v0.7.0.

### Finding by finding

| Veil finding (2026-09-17 audit) | Under OpenZeppelin | Evidence |
|---|---|---|
| **Upgradeability gap** (§1 — no contract can be upgraded) | **Fixed.** `upgrade` requires the account's own authorisation and ignores the operator argument — exactly the §6 rule "never an operator key" | `examples/.../account/src/contract.rs:89-93`: `e.current_contract_address().require_auth()` |
| **H-1** factory squatting bricks a wallet via a hostile origin | **Harm removed, UX change required.** No rp_id/origin is stored, so there is nothing to poison. Address occupation is still possible (the default deployer seed is public), so SAK verifies each wallet's on-chain birth — deployer, salt, WASM, constructor signers and policies — and never treats an address as usable until that passes | SAK `docs/security-deterministic-deployer.md` |
| **H-2** factory dies after ~1k wallets | **Gone.** No global registry; each wallet is its own `CreateContractV2` deployment | SAK deployment manifest |
| **H-3** SDK builds 4 signature elements, contract wants 5 | **Replaced.** New auth format (`AuthPayload` with explicit `context_rule_ids`). All three signing paths get rewritten against it — the natural moment for V151's single shared implementation | `smart_account/storage.rs:468` |
| **H-4** spend-limit bypass via `execute`, negative amounts, self-removal | **Fixed.** Fails closed: any call under a limited rule that is not a well-formed `transfer` is `NotAllowed`. Negatives are `LessThanZero`. Limits change only with the account's authorisation, and a signer scoped to a token contract cannot authorise calls to the policy | `policies/spending_limit.rs:252-317, 347` |
| Spend limits asset-blind (~9× in USDC) | **Fixed if rules are scoped.** A rule on `CallContract(USDC)` is USDC-denominated. A `Default` rule would sum across tokens again, so scope every limited rule to one token | `smart_account/mod.rs` rule types |
| **H-5** recovery keeps stale pending state and a thief's keys | **Not applicable — and no recovery built in.** No guardian or timelock flow, so no recovery bugs, but also no 7-day guardian recovery. See "What we give up" | — |
| `add_signer` reuses indices, no duplicate check | **Fixed.** Monotonic `NextId` counter; canonical duplicate check on every signer set | `smart_account/storage.rs:642, 543` |
| No `extend_ttl` on signer/instance state | **Fixed.** Account storage and every policy extend their TTLs | `storage.rs:1427`, policies |
| WebAuthn parsing loose (challenge/type substring match) | **Fixed.** clientDataJSON is parsed as JSON; exact `type == "webauthn.get"` and exact challenge; UP, UV and backup-flag consistency checked | `verifiers/webauthn.rs:121-259` |
| Custom contract nonce, unsigned | **Gone.** Replay protection is the host's auth-entry nonce | — |
| Multisig/vault `initialize` front-runnable, duplicate owners | **Fixed** for multisig: signers and policies are constructor arguments, duplicates rejected | `account/src/contract.rs:32` |
| **CR-1** client signs any auth entry the RPC returns | **Not fixed — client-side.** Context rules shrink the blast radius only for *scoped* signers; the primary passkey on a `Default` rule can still authorise anything. **V150 is required whatever is decided here** | — |
| **CR-2 / CR-4** agent blind-signs, unbounded x402 | **A much better design becomes available.** Give the agent its own signer on a rule scoped to specific contracts, with a spending limit and a `valid_until`. The agent then *cannot* move more than its allowance, whatever it is told | `smart_account/mod.rs` context rules |

### What we give up

- **Origin and RP-ID binding.** OpenZeppelin deliberately does not check them (documented at
  the top of `webauthn.rs`), and neither does passkey-kit: passkeys are already scoped to
  their relying party by the platform. Veil's checks were defence in depth. Dropping them is
  also what removes H-1's permanent-brick vector, so this is a trade, not a pure loss.
- **Receiving before deployment.** Veil lets a new wallet receive to its counterfactual
  address and deploys on first spend. With a public deterministic deployer that address can
  be occupied by someone else's constructor arguments, so SAK's rule is: never show an
  address as a deposit address until its birth is verified. v2 deploys at creation instead.
  The cost per wallet is small (SDF's five instance deployments came to 0.09 XLM together),
  but it means a sponsored deploy on sign-up — and **the `passkey-kit` demo failure on
  2026-09-22 ("Resource fee exceeds configured maximum", `RelayerError [7002]`) is exactly
  this step hitting a relayer's fee cap.** Veil's own fee payer would sponsor it, with its own
  cap to set.
- **Guardian recovery with a timelock.** Not in the library. Options: (a) a second device's
  passkey as a normal signer — simplest, audited; (b) a guardian signer on its own rule — no
  delay; (c) a custom timelock policy — unaudited code of ours, reintroducing the risk this
  move is meant to remove. Start with (a).

### Caveats on "audited"

- SAK's mainnet artifacts are built from `stellar-contracts@1e513890`, **a later revision
  than the v0.7.0 audit scope**. Say "built on OpenZeppelin's audited smart-account library",
  and either pin to the audited tag or state the revision gap. Do not say "audited wallet".
- `smart-account-kit` itself (the TypeScript SDK, relayer proxy, indexer) is **unaudited** by
  its own README. Using its contracts does not require using its SDK.

### Cost and migration

- **Mainnet deploy cost drops to near zero.** SDF has already uploaded the account WASM
  (`1b5f4534…785a`) and deployed the WebAuthn verifier, the ed25519 verifier and all three
  policies (≈ 91 XLM in upload fees, paid by them). The verifier and policies have **no
  upgrade function and no owner**, so reusing them adds no trusted party — only their WASM
  hashes need checking against a reproducible build. Compare ≈ 40 XLM for our own v2 (§5).
- **Users keep their passkey.** A WebAuthn signer's key data is the 65-byte uncompressed
  P-256 public key (optionally followed by the credential id) — what Veil already stores.
  Migration is: deploy an OpenZeppelin account with the user's existing passkey as signer,
  then one passkey-signed transfer of each balance out of the old wallet. One prompt, no
  re-registration.
- **Mobile needs a spike.** SAK uses browser WebAuthn; the app uses `react-native-passkeys`.
  SAK's generated bindings for transaction building, plus our own passkey adapter, is the
  likely path. Unmeasured — do not estimate it until the spike is done.

### Recommendation

Adopt OpenZeppelin smart accounts for v2; do not build our own contract v2.

1. It closes more of §6 and of the 2026-09-17 audit than our own v2 would, with code that has
   had four audit rounds instead of none.
2. It replaces the most expensive line in an SCF budget — an audit, which SCF will not fund —
   with "composes OpenZeppelin's audited library", which is also the Integration Track's
   thesis.
3. It is cheaper to deploy, and SDF already runs the same contracts on mainnet, so reviewers
   will recognise the stack.

**Before committing:** the mobile passkey spike; a testnet end-to-end (create → receive →
spend → swap → cash-out) against SDF's testnet deployment; a check that our fee payer can
sponsor account creation under a sensible cap; and a reproducible-build check of the shared
contracts' WASM hashes. **Independently of this decision:** ship V150 — no contract fixes CR-1.

If adopted, §6 is superseded: the upgrade, spend-limit and multi-wallet items become
configuration (rules and policies) rather than contract code, and the factory items go away.
