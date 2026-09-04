# Veil — Stellar Community Fund Strategy

> The definitive, honest go-to-SCF plan for Veil. Written to survive reviewer verification, not to flatter the team. Every claim is sourced to the five recon reports (SCF program mechanics; past winners & the winning pattern; competitive landscape; zk-on-Soroban feasibility; and an honest codebase audit) and to repo state as of 2026-08-19, **updated 2026-08-23 with verified mainnet receipts (§0)**.

---

## 0. Mainnet receipts (verified on-chain 2026-08-23)

**Veil is live on Stellar mainnet.** This section supersedes every "testnet-only" framing below; §1's blocking gaps #1 and #3 are closed on mainnet and the pitch moves from *"fund us to reach mainnet"* to *"we're on mainnet — fund us to scale it."*

**Deployed, source-verified.** Factory `CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK`, built through `scripts/reproducible-build.sh` (docker `rust:1.85.0-bookworm`). On-chain bytecode matches `contracts/expected-hashes.json` **byte for byte** — verified by reading the ledger directly:

| Artifact | expected-hashes.json | On mainnet |
|---|---|---|
| `factory.wasm` | `3a6756d2…b853` | factory instance executable ✓ |
| `invisible_wallet.wasm` | `b485f817…9ea5` | factory `WasmHash` **and** the deployed wallet's executable ✓ |

A reviewer can reproduce the build locally and match mainnet bytecode. The reproducible-build claim now *verifies* — on the network that counts.

**Real transactions** (all on Stellar public network, source account `GAE6BEVE…OWUJY`, wallet contract `CDUS5S3AENE5QREEHCIEHGKMP6LMBDELUYB35ZSFYETXETN2674MXQHK`):

| # | What it proves | Tx hash | Result |
|---|---|---|---|
| ① | Sponsored classic send to an external wallet (LOBSTR) | `3ef7598f6cc3c4d96032d5ea5df17ef543fbe06cdd008b8640bc917cc09cab5c` | 2 XLM delivered |
| — | Passkey wallet **deployed** via the factory | `acbc3147c89cb1ccca486ff80b8293d0c1d3d2c306600c27c52c2b64aa0f57fe` | contract live |
| ② | Funding the smart wallet over the native SAC | `8d0e14c543184e400dee37d16b1377c59b301862f4e21e5aa845a303874e596f` | 2 XLM in |
| ③ | **`__check_auth` spend — a WebAuthn passkey authorizing a mainnet transfer on-chain** | `626e110b61b709afb2d85c14517e7678b95b07e4d49c34a6caff8ee51148ebcc` | 1 XLM out to LOBSTR |
| ④ | **Soroswap aggregator swap** (live third-party DEX integration) | `5e29e3d8cdd27ba25f510e5dbf412e9e6592dabdf761508266a8752bfd096f4f` | 1 XLM → 0.2024626 USDC |

③ is the crown jewel: a `secp256r1` passkey signature verified **inside the contract by Soroban's host functions on public mainnet**, with no seed phrase and no gas token in the user's hands. ④ settled at a better rate than the classic order book's mid (0.2025 vs 0.192 USDC/XLM), through Circle's real USDC issuer.

**Live self-serve demo.** The mobile app runs against an owned, permanent WebAuthn relying party — `app.useveilapp.xyz` (registrar → Vercel DNS, Android `assetlinks.json` served) — so passkeys created today survive to production instead of being stranded on a `*.vercel.app` domain.

**Still honest about the gaps.** The *testnet* factory remains stale relative to `expected-hashes.json` (the original gap #1) and should be redeployed for parity; mainnet is the one that verifies today. Volume is a handful of self-funded test transactions, not user traction — the Integration Track volume metric (§5F) remains the traction commitment, and it is now measurable against a wallet that already works on mainnet.

---

## 1. Verdict

**Veil is fundable — but not today, and not on the Open Track. It is a ~2–4 week gap-closure sprint away from a credible Integration Track submission.**

- **Award:** SCF Build Award, **Integration Track**. Up to **$150,000 in XLM** per award (paid in XLM, valued at the CF settlement price on payment date; capped), with a lifecycle path to **$300,000 total** in follow-on awards. Realistic ask for a consumer stablecoin wallet at Veil's traction level: **$60k–$110k**, not the cap.
- **Cadence / next deadline:** Rounds run on a **6-week cycle**. **SCF #46 is open now with a submission deadline of 8 November 2026** (#45 closed 16 Aug 2026) — verified 2026-08-23, superseding this doc's earlier "~late Sep/early Oct" estimate. That is **~11 weeks of runway**, comfortably more than the 2–3 engineer-days of blocking work left. The entry gate is the **rolling Interest Form** at communityfund.stellar.org; submit it **now** — it is reviewed on a rolling ~2-week basis and gates invitation into a round. A referral is described as "an important part of the process" but is **not mandatory**.

- **No company registration is required to apply.** The Official Rules admit *"Teams of Eligible Individuals"* alongside incorporated Organizations — the incorporation requirement is scoped only to the Organization branch. KYC happens **post-selection, pre-disbursement**, with an explicit individual path, and payment is **XLM to a wallet we control**, so no corporate bank account is needed. Nigeria is not on any exclusion list, and the Budget Guidelines list *"entity registration costs"* among things SCF will not fund — hard to square with incorporation being mandatory. Solo builders have won repeatedly (VRF-Soroban $50k at SCF #44, Digicus $150k, both team-size-1). **This decouples the SCF application entirely from the Nigerian CAC/VASP problem** (see `docs/NGN_RAILS.md`), which is the single most useful sequencing fact we have.

**Why Integration, not Open:** The Open Track requires clearing a public **Community Vote via Neural Quorum Governance (NQG)** — a ~10–20% NQG-score threshold and 66% approval, where vote weight scales with Verified Tier, peer-delegated trust, and *historical SCF contributions*. Veil has **no** SCF track record and thin community embedding (~$29 lifetime on Drips). Recon shows ~76% of recent winners came through the referral channel; walking into an NQG vote cold is the weakest possible position. Integration Track is **panel-only** (no community vote) and rewards exactly what Veil is: a product that **composes existing Stellar building blocks** (USDC, Blend yield, Soroswap, MoneyGram rails, SEP-2 federation) with real cross-repo scaffolding. The tradeoff Veil must accept: Integration ties the final **40% tranche to a committed, panel-ratified on-chain metric** (cumulative volume / NAV or equivalent) — so we must commit to a realistic mainnet volume number and hit it.

**What must change before applying (blocking):** SCF requires the technical architecture to be **already complete** (Veil now exceeds this — contracts are cargo-verified and *running on mainnet*, §0) and the roadmap to slot into **three tranches ending at verified mainnet launch**. Of the three repo facts that would have failed a cloning reviewer, **two are now closed by the mainnet deployment** (details and effort in §4):

1. ~~**Reproducible-build hash mismatch**~~ — **CLOSED on mainnet (2026-08-23).** The mainnet factory and the wallets it deploys match `expected-hashes.json` byte for byte (§0). The *testnet* factory is still stale and should be redeployed for parity — a tidy-up, no longer a credibility hole.
2. **Clone-and-run is broken** — the factory contract ID lives only in CI/Vercel env; the local default is empty and example files ship the null address `CAAAA…BSC4`. A reviewer who `git clone && npm run dev` gets a wallet that cannot create an account. **Still open, and now cheaper to fix**: the mainnet factory ID is a real, permanent default to commit.
3. ~~**No live self-serve demo on a public network**~~ — **CLOSED.** The wallet is live on mainnet at an owned relying-party domain with four verifiable transactions including a passkey-authorized spend and a DEX swap (§0). Remaining polish: the cold Render backends (§4 gap #4) still need waking or feature-flagging on the demo path.

None of these were architectural — they were packaging and deployment hygiene, and the mainnet push resolved most of them. **The remaining blocking work is roughly one engineer-day** (gap #2 plus the backend flagging), not the original 3–5.

---

## 2. The winning pitch

**Narrative (one paragraph):**
> Veil is a self-custodial, USDC-backed consumer neobank on Stellar for high-inflation markets, starting with Nigeria/Africa. It removes the two things that keep normal people off crypto rails: seed phrases (replaced by **WebAuthn passkeys** and Soroban's `secp256r1` `__check_auth`) and gas (fees are **sponsored — an "invisible wallet," no gas token ever touches the user**). On top of that it shows balances in **local fiat over USDC**, earns **USDC yield via Blend**, supports **send-by-name and claim links**, and is building the ecosystem's first consumer-facing **on-chain shielded transfer pool** — private payments where amounts are hidden, built on Stellar's native BLS12-381 zk host functions. Stellar is not a storage layer here; it is the settlement rail, the auth primitive, and the privacy engine. Veil productionizes the passkey+gasless+Soroban stack that SDF's own Meridian Pay proved, as a fiat-facing African neobank — a category no shipped Stellar wallet occupies.

**The 3 differentiators that actually win** (mapped to what recon says SCF and winners reward):

1. **On-chain privacy (the headline moat).** Recon is unambiguous: **no shipped Stellar consumer wallet** — not Vibrant/Vesseo, Beans, Decaf, or LOBSTR — exposes confidential amounts to users, and industry consensus calls privacy the **#1 unmet need in stablecoins**. SCF is *actively courting* this: the X-Ray/Protocol 25 upgrade (mainnet Jan 22 2026) shipped native BN254 + Poseidon precisely to enable "compliance-forward privacy applications," and SCF has already funded privacy/zk repeatedly (ZK Bricks $50k, Warmancer $136.5k, Reclaim $50k, LumenShade privacy pools, Sollpay keyless-ZK). This is Veil's cleanest, most defensible, best-timed edge — and it's *literally the project's name*.
2. **Seedless passkeys as the default (real, time-limited edge).** Proven on Stellar (Meridian Pay, 1,000+ tx, no seed/gas) but not yet the default in a shipped consumer neobank. Maps directly to the rubric's "Stellar used to *meaningfully improve core features*, not superficial integration": passkeys + `__check_auth` are core UX, not decoration. Frame as a 12–24 month lead, not a permanent moat.
3. **The bundle, aimed at a specific underserved market.** The winning pattern recon extracts is: *real product + validated market + core Stellar rail + differentiation + mainnet roadmap*, and the biggest checks (Yolat $110k, Bexo $90k) went to **cross-border stablecoin apps with fiat UX for a specific region**, not to novelty in isolation. Every competitor has 3–4 of {gasless, passkey, local-fiat, yield, send-by-name, privacy}; **none has all six, and none pairs them with privacy**. Veil's defensible position is the *bundle in one Africa-focused product* — pitched as a payments/neobank story (which wins bigger and more often) rather than as abstract "privacy tech."

**Deliberately NOT headlined** (recon says these are table stakes): gasless UX (Decaf already gasless) and send-by-name (standard SEP-2 federation, shipped in Scopuly). Market them as polish, never as the pitch.

**A fourth angle worth claiming — the Integration List has no African rail.** The Integration Track requires integrating a building block from SCF's official Integration List. Its on/off-ramp category (Etherfuse, alfredpay, MoneyGram, Bridge, Abroad, BlindPay, Mercuryo, Anchor Platform, Koywe) is **heavily LatAm-weighted with nothing serving Africa or Nigeria** — a gap we are credibly positioned to fill, and a sharper framing of the market story than "Africa-focused" in the abstract.

Better still, **Anchor Platform is itself on that list**, and the mobile app already carries a working SEP-24 implementation (`lib/sep24.ts` — TOML discovery, SEP-10 auth, interactive deposit *and* withdraw, status polling). So a SEP-6/SEP-24 offramp built on Anchor Platform is simultaneously (a) a legitimate testnet crypto→fiat demo needing **no licensed partner and no legal exposure**, and (b) a qualifying Integration Track integration. That is the cheapest path from where the code already is to a fundable, demonstrable offramp — and it sidesteps the Nigerian licensing problem entirely for the purposes of the application.

**And there is a real Nigerian anchor to demo against.** NGNC by Link.io (`ngnc.online`) is the only live SEP-24 NGN anchor on Stellar; verified 2026-08-23, its SEP-10 and SEP-24 endpoints respond correctly and our client should authenticate unmodified. Its ₦20,000 (~$13) minimum deposit makes a real end-to-end naira demo affordable. Be honest about it in the application, though: ~$70k total float and ~$300 of on-chain exit liquidity mean it is a **demo rail, not a production one** — which is precisely why an African on/off-ramp is a gap worth funding rather than a solved problem.

### 🔑 SEP-45 — a differentiator hiding in plain sight

SDF's reference anchor now ships **SEP-45: contract-account authentication** (`WEB_AUTH_FOR_CONTRACTS_ENDPOINT` + `WEB_AUTH_CONTRACT_ID`, live on testanchor.stellar.org today). It lets a Soroban smart wallet authenticate to an anchor *directly*, instead of requiring a classic ed25519 keypair to sign a SEP-10 challenge.

For Veil this is unusually well-aimed. Our whole architecture is a contract-based passkey wallet, and SEP-10 is an architectural mismatch with it — the withdraw screen currently has to authenticate as the fee-payer G-account because a C-address cannot sign a SEP-10 challenge. **SEP-45 is the primitive our design has been missing**, no shipped consumer wallet uses it yet, and it strengthens exactly the argument the Integration Track rewards: Stellar used to *meaningfully improve core features*, at the protocol's leading edge, in a way that is not portable to another chain. Worth a spike, and worth naming in the application.

---

## 3. Track, award size, timeline

| Item | Value | Source (recon) |
|---|---|---|
| Program | SCF 7.0 Build Award (launched Jan 2026, current version) | SCF v7 blog / handbook |
| Track | **Integration** (composes existing Stellar building blocks; panel-only, no NQG vote) | Build Award submission criteria |
| Award ceiling | **$150,000 in XLM** per award; up to **$300,000** lifecycle via follow-on | budget-and-deliverable-guidelines; v7 blog |
| Realistic ask | **$60k–$110k** (consumer-wallet band: Skopa $37.8k, Bexo $90k, Yolat $110k) | SCF #44 recap; awards page |
| Cadence | **6-week cycle**; enter via rolling **Interest Form** | communityfund.stellar.org/awards |
| Next deadline | **SCF #46 submissions are OPEN — deadline 8 November 2026** (#45 closed 16 Aug 2026). Corrected 2026-08-23; the earlier "~late Sep/early Oct" was an estimate | communityfund.stellar.org/awards |
| Process | Interest Form (~2wk) → invited Submission Form (~1wk) → Prescreen + Delegate Panel (~1wk) → *(Open only: NQG vote)* → KYC/KYB → disbursement | submission-criteria |

**Tranche structure (v7 performance-based, 10/20/30/40):**

| Tranche | % | Milestone | Veil deliverable |
|---|---|---|---|
| #0 | 10% | On award acceptance | KYC/KYB for Miracle656 + every paid contributor |
| #1 | 20% | MVP | Passkey wallet + gasless send + local-fiat display + Blend earn **on mainnet** (core already live, §0); clone-and-run works; production RPC off the trial plan |
| #2 | 30% | Testnet (+ threat model + monitoring plan) | Shielded-pool **testnet MVP** (fork-and-harden of `soroban-privacy-pools`, recipient-bound proof) + published threat model + service monitoring |
| #3 | 40% | Verified **mainnet launch** + UX readiness | Committed on-chain **cumulative-volume** metric from real users (Integration Track T#3 releases against this, not launch alone) + NGN fiat on/off-ramp wiring |

**Note on T#1 after the mainnet push:** the milestone the award structure expects at Tranche #1 is largely *already delivered* — that is a strength to state plainly, not padding to hide. It means the funded work starts at hardening and the privacy flagship rather than at basics, and it lets us argue T#1 as a short, verifiable tranche.

**Timing rules:** total timeline **≤ 6 months** (3–5 expected); each tranche deliverable **within 90 calendar days** of the prior payment or the remaining balance is forfeited. **Budget may fund only forward-looking, Stellar-integrated dev.** Explicitly **unfundable**: audit fees, marketing, bounties, token giveaways, legal fees, and *reimbursement for past work* — so the merged contributor PRs and existing code are **not** reimbursable; budget must be forward dev only.

**Sequencing after a win:** Build Award → mainnet + Audit Bank (5% refundable co-pay; only unlocked *after* SCF funding) to close the open C2/C3/H2 security items → Growth Hack.

---

## 4. Gap-closure plan (ranked by SCF-review impact)

### MUST FIX before applying / before the demo

| # | Gap (from codebase audit) | Status | Why it hurts | Shortest credible fix | Effort |
|---|---|---|---|---|---|
| 1 | **Reproducible-build hash mismatch** (testnet factory deploys `dac3c204…` ≠ pinned `b485f817…`) | **CLOSED on mainnet** 2026-08-23 — mainnet factory + wallets match `expected-hashes.json` byte for byte (§0) | Was: README sells reproducible builds as a trust feature and a verifying reviewer found it *failed* | Remaining tidy-up: redeploy the **testnet** factory from HEAD so both networks agree | 0.5 day |
| 2 | **Clone-and-run broken** (factory ID only in CI/Vercel env; local default empty; examples ship null addr) | **OPEN** | Reviewer who clones + `npm run dev` gets a wallet that can't create accounts — kills the "architecture complete" claim | Commit the **mainnet** factory ID (`CCZ3JLRE…OQ7BK`) as the default in `frontend/wallet/lib/network.ts` and `.env.example`; mobile already defaults correctly | 0.5 day |
| 3 | **No live self-serve demo on a public network** | **CLOSED** — mainnet wallet at an owned RP domain, four verifiable txs incl. a passkey spend and a DEX swap (§0) | Was: SCF weights "can I see it work publicly" heavily | Remaining: record the mainnet happy-path as a demo video for the submission | 0.5 day |
| 4 | **Backends (wraith/lens/agent) not in-repo & likely cold on Render free tier** | **OPEN** | Any demo feature (activity feed, price oracle, AI agent, x402) 503s mid-demo | Wake/verify the three Render services or self-host `packages/agent` with `AGENT_KEYPAIR_SECRET`; gate un-revivable features behind flags on the demo path | 0.5–1 day |
| 5 | **Mainnet RPC is a 30-day QuickNode trial** | **OPEN — hard deadline** | The mainnet app stops working when the trial lapses, mid-review in the worst case | Move to a paid plan or a second provider before submission; the RPC URL is env-driven, so it's a config change | 0.5 day |

**Subtotal: ~2–3 engineer-days remaining** (was 3–5; the mainnet push closed the two heaviest). Still all packaging/deploy hygiene, no architecture.

### NICE TO HAVE (strengthens, not blocking)

| # | Gap | Fix | Effort |
|---|---|---|---|
| 5 | **SDK unpublished** (`invisible-wallet-sdk` workspace-only; consumers import source via tsconfig alias) | Publish `invisible-wallet-sdk@0.1.0` to npm; point one example at the *published* package — cheapest high-value ecosystem-story lever (memory names npm dependents as the un-pulled lever) | 0.5 day |
| 6 | **Signing key in plaintext localStorage** (`recover/page.tsx:240`; open items C2/C3) | Don't hide it — **disclose as known/roadmapped**, and sequence the fix into the post-award Audit Bank engagement | disclose now; fix post-award |
| 7 | **Thin contract coverage** (multisig 2 tests, vault 5, vs invisible_wallet 136) | Don't claim "production-ready multisig/vault"; scope vault/multisig honestly as roadmap | narrative only |
| 8 | **Mobile e2e red on main** (Maestro pre-existing-RED) | Don't claim mobile is demo-ready without a green run; lead the demo with web | narrative only |

**Deprioritized for the application itself:** mainnet deploy (this is the *funding ask* / Tranche #3, not a prerequisite), vault/multisig depth, and the localStorage hardening (disclose honestly rather than hide).

---

## 5. Draft application answers

Answering the actual required content categories surfaced in recon (the handbook exposes categories, not verbatim field strings).

**A. Product readiness & traction**
> Veil is a working, self-custodial USDC neobank with a live web wallet (25 routes: dashboard, send, receive, swap, buy, earn, vault, pools, multisig, agent, contacts, withdraw, recover) and a ~30-screen Expo/React Native mobile app, both wired to real integrations — Soroswap (live quote/build), Blend yield, and the deployed wallet+factory contracts. The Soroban contract suite is cargo-verified (invisible_wallet 136 tests, factory 26) and **is deployed and transacting on Stellar mainnet**: factory `CCZ3JLRE…OQ7BK`, whose on-chain bytecode matches our published reproducible-build hashes byte for byte, has deployed a passkey smart wallet that has **authorized a real mainnet payment via `__check_auth`** (tx `626e110b61…`) and **executed a Soroswap aggregator swap into Circle USDC** (tx `5e29e3d8cd…`). Users' passkeys are bound to an owned production domain (`app.useveilapp.xyz`), not a throwaway preview host. Traction is early and we state it plainly — the mainnet volume so far is our own verification transactions, not users — so the *validated need* is the strongest demand signal — recon-grade market evidence that privacy is the #1 unmet need in stablecoins, that self-custodial USDC neobanks for high-inflation markets are a proven, repeatedly-funded category (Vibrant, Beans, Bexo, Yolat), and that no shipped Stellar wallet yet pairs seedless passkeys with local-fiat UX and on-chain privacy. Our commitment: a mainnet launch with a committed cumulative-volume target as the Integration Track T#3 metric.

**B. Stellar use case & integration (why Stellar is necessary)**
> Stellar is the settlement rail, the authentication primitive, and the privacy engine — not storage. (1) USDC on Stellar + MoneyGram Ramps (300k+ cash locations) + Blend yield give us mature fiat on/off and yield rails to reuse, not rebuild. (2) Soroban's `secp256r1` + `__check_auth` (Protocol 21) make WebAuthn passkeys the login, eliminating seed phrases at the protocol layer — the same stack SDF's Meridian Pay proved. (3) Fees are sponsored so no gas token touches the user. (4) The privacy flagship uses Stellar's **native BLS12-381 host functions** (CAP-0059, Protocol 22) plus native Poseidon/BN254 from X-Ray/Protocol 25 to verify Groth16 proofs on-chain — a capability that is Stellar-specific and now on mainnet. None of this is portable to a "put it on any chain" story; it is Stellar-native by construction.

**C. Technical architecture (must already be complete)**
> Complete, in-repo, and **proven on mainnet**. Contracts: `invisible_wallet` (passkey smart wallet, `__check_auth`), `factory` (deterministic wallet deploy), `vault`, `multisig-wallet` — cargo-tested, WASM built via a pinned reproducible docker build, with wallet+factory **deployed to Stellar public network and verified against our published hashes** (§0); vault and multisig remain testnet-scoped and we scope them as roadmap, not shipped. Frontend: Next.js web wallet + Expo mobile, both consuming the SDK. The shielded-pool architecture is specified as a **fork-and-harden** of Stellar's own `soroban-privacy-pools` reference (Groth16 / BLS12-381 / Poseidon / Circom), with the one open reference gap — binding recipient/relayer/fee into the proof's public inputs — explicitly scoped as our first hardening task. Tranche 1 is actual development, not planning.

**D. Development roadmap (three tranches)**
> **T#1 (MVP):** source-verified fresh testnet factory + clone-and-run + passkey wallet, gasless send, local-fiat display, Blend earn. **T#2 (Testnet + threat model + monitoring):** shielded-pool testnet MVP (fixed-denomination USDC pool, on-chain incremental Merkle tree, nullifier store, recipient-bound Groth16 proof, relayer) + published threat model + service monitoring. **T#3 (Mainnet + UX readiness):** wallet + factory + earn on mainnet, committed cumulative on-chain volume metric. All within 6 months; each deliverable within 90 days of the prior payment.

**E. Itemized budget (forward-looking, Stellar-integrated only)**
> Ask: **$60k–$110k in XLM**. Line items cover only forward Stellar-integrated engineering: (i) mainnet deployment + reproducible-build verification pipeline; (ii) shielded-pool circuit hardening (recipient binding), on-chain verifier + Merkle/nullifier contract, relayer service, trusted-setup ceremony; (iii) passkey/recovery hardening for mainnet; (iv) fiat display + Blend + MoneyGram-ramp production wiring. **Excluded (per rules):** audit fees, marketing, bounties, giveaways, legal, and any reimbursement for existing/past work.

**F. Integration Track on-chain metric commitment**
> We commit to **cumulative USDC payment volume** on mainnet as the panel-ratified T#3 metric, with a threshold set realistically to our launch cohort (to be negotiated with the panel) — released against verified on-chain volume, not launch alone.

**G. Smart-contract open-source plan**
> All contracts are and remain open-source (MIT, added across repos 2026-08-18). The shielded-pool verifier, Merkle/nullifier contract, and relayer will ship open-source with a documented trusted-setup ceremony.

---

## 6. The shielded-pool play

**Feasibility verdict (recon, HIGH confidence): buildable on Soroban today.** The hardest question — *does a real zk-SNARK verify on-chain inside budget?* — is answered YES by a working Stellar prototype: Groth16 verify costs **~40M instructions (~40% of the ~100M budget)** using native BLS12-381 host functions, leaving headroom for Merkle/nullifier logic and the token transfer in the same tx. A near-complete open-source reference (`soroban-privacy-pools`, Groth16/BLS12-381/Poseidon/Circom, plus `circom2soroban`) already exists. **This is fork-and-harden, not greenfield: ~4–10 engineer-weeks to a solid testnet MVP.**

**How to frame it in the application — flagship, without over-promising:**

- **DO** headline it as the strategic differentiator and the reason "Veil" is named for privacy, framed as **compliance-aware privacy** (Privacy Pools + Association-Set-Provider design — parties known, amounts hidden — *not* an anonymity mixer). This matches SDF's own X-Ray "compliance-forward privacy" language and de-risks the regulatory read.
- **DO** place it in **Tranche #2 (Testnet)**, not Tranche #1 and not as a mainnet launch-gate. The wallet's passkey/gasless/fiat/yield core is the MVP; privacy is the testnet milestone. This keeps the flagship visible while making the fundable path *not* depend on shipping novel crypto to mainnet in 3 months.
- **DO NOT** promise a mainnet shielded pool holding real user funds inside the 6-month window. A mixer holds pooled funds; nullifier/Merkle bugs are catastrophic and it needs its own audit. Over-promising here is the single biggest credibility risk. Frame **mainnet privacy as the follow-on Build Award** (the $150k→$300k lifecycle path) and route it through Audit Bank first.

**Minimal viable version (the T#2 deliverable):** a **fixed-denomination (e.g. 100 USDC) pool** — `deposit(commitment = Poseidon(nullifier, secret))` appended to a fixed-depth on-chain Merkle tree with rolling root history; `withdraw(proof, root, nullifierHash, recipient, relayer, fee)` that (1) checks root ∈ history, (2) marks nullifierHash spent, (3) Groth16-verifies via `env.crypto().bls12_381().pairing_check`, (4) pays recipient via the USDC SAC and fee to the relayer. **Two non-negotiables from recon:** (a) **bind recipient/relayer/fee into the proof's public inputs** — the one gap the reference left open; without it withdrawals are front-runnable; (b) **never** verify by importing arkworks into the WASM guest (~560M instructions, 5.6× over budget) — always route pairings/MSM through the host functions. Groth16 needs a trusted-setup ceremony (or move to a universal-setup Plonk-family scheme).

---

## 7. Risks & rebuttals

**"Veil has earned only ~$29 on Drips across three repos — where's the traction?"**
> Drips is a passive tip stream, not a demand signal, and it funded *past* work SCF explicitly won't reimburse anyway. SCF's own criteria accept traction that is "on Stellar, another chain, or off-chain" *or* "a clearly validated need identified by a team with relevant experience." Veil's case rests on the validated need — privacy as the #1 unmet stablecoin need, a repeatedly-funded consumer-USDC-neobank category, and a working multi-repo codebase — plus a committed mainnet volume metric as the Integration Track's own traction gate. We are asking SCF to fund the *conversion* of working code into mainnet traction, which is precisely what the Build Award is for.

**"The backend services (wraith/lens/agent) look dead."**
> Correct that the Render free-tier services sleep, and we're addressing it before submission (§4 gap #4): waking/self-hosting them and feature-flagging any demo path that would otherwise 503. The core wallet demo — passkey create → fund → send → swap → earn — runs entirely against deployed *on-chain* contracts and needs none of those backends. wraith (analytics) and lens (oracle) are sister projects, not load-bearing for the funded wallet path.

**"You're testnet-only — nothing is on mainnet."**
> Not any more. As of 2026-08-23 the factory and a passkey smart wallet are **deployed and transacting on Stellar public network** (§0), including a `__check_auth` spend authorized by a WebAuthn passkey and a Soroswap swap into Circle USDC — four verifiable transaction hashes, not a promise. What we are *not* claiming is user traction: that volume is our own verification activity, and converting a working mainnet wallet into real payment volume is exactly what the Integration Track metric (§5F) commits us to. The ask shifted accordingly — from "fund us to reach mainnet" to "we reached mainnet on our own; fund the privacy flagship and the scale-up."

**"Your reproducible-build claim doesn't verify / the repo doesn't run on clone."**
> The reproducible-build claim **verifies on mainnet today**: the deployed factory's own bytecode and the wallet WASM it deploys both match `contracts/expected-hashes.json` exactly (`3a6756d2…` and `b485f817…`), reproducible from the pinned `rust:1.85.0-bookworm` docker build — read straight off the ledger, §0. Two honest leftovers, both closing before submission: the *testnet* factory predates the current hashes and gets redeployed for parity, and we're committing the mainnet factory ID as the in-repo default so `git clone && npm run dev` produces a working wallet with zero secret config (§4 gap #2).

**"Privacy on Stellar is unproven — are you over-promising?"**
> No — and we're careful to scope it. On-chain Groth16 verification is *already proven on Stellar* (SDF's own prototype, ~40% of budget, native BLS12-381), and a reference implementation exists, so our privacy work is fork-and-harden, not research. We deliberately place the shielded-pool at Tranche #2 (testnet MVP), keep the fundable path independent of shipping novel crypto to mainnet, and route a mainnet privacy pool holding real funds through a follow-on award + audit. The compliance-aware Privacy-Pools/ASP design (not an anonymity mixer) matches SDF's stated X-Ray direction.

**"Passkeys and gasless aren't unique."**
> Agreed on gasless (Decaf) and send-by-name (SEP-2, Scopuly) — we present those as polish, not the pitch. The defensible position is the *bundle* — gasless + passkey + local-fiat + yield + send-by-name + privacy in one Africa-focused product; every competitor has 3–4, none has all six, and none pairs them with on-chain privacy. Privacy + seedless passkeys are the two headline differentiators; the rest is table-stakes execution done well.

---

*Sources: SCF handbook (build-award, submission-criteria, budget-and-deliverable-guidelines, NQG, Audit Bank), stellar.org SCF v7 blog, communityfund.stellar.org/awards, SCF #43/#44 recaps, Stellar "Prototyping Privacy Pools" engineering blog, CAP-0059 / X-Ray Protocol 25 guides, and the Veil codebase audit (repo state 2026-08-19). The §0 mainnet receipts were read directly off the Stellar public-network ledger on 2026-08-23 (contract instance storage for the factory and wallet; Horizon transaction and operation records for the payments and the swap) — every hash there is independently verifiable. Time-sensitive figures (current round number/deadline) must be re-verified on communityfund.stellar.org before submitting.*
