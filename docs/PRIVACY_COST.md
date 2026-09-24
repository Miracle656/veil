# Private payments on Veil — what exists, what it costs

**Researched:** 2026-09-14 · **Question:** Stellar now has privacy transactions (with Nethermind). Talise shipped shielded balances on Sui; what would the equivalent cost Veil on Stellar?

**Short answer:** we no longer need to build a privacy pool. SDF and Nethermind have one, and a private transaction costs **about $0.003** in fees (measured). The real costs are **~9–15 engineer-weeks of integration** (mobile is the hard part), **a history server for note discovery**, and **compliance/legal work**. It is **not usable on mainnet yet**: the pool is an unaudited testnet preview. Start on testnet now; ship to mainnet when theirs is audited and approved.

---

## 1. What Stellar has now

| | Stellar Private Payments (SPP) | Confidential Tokens |
|---|---|---|
| Built by | Nethermind (with SDF) | OpenZeppelin contracts + Nethermind UltraHonk verifier |
| Hides | **Who paid whom and how much** — a shared shielded pool | **Amounts and balances only**; sender and recipient addresses stay public |
| Proofs | Groth16 over BN254, Circom circuits, proved on the device | Noir, UltraHonk |
| Compliance | Association Set Providers (allow-list / block-list per pool), freeze, selective disclosure, global view keys | Auditor view key, selective disclosure, freeze, policy engine |
| Status | **Developer preview, unaudited, testnet only**, "not yet approved for mainnet" | **Developer preview, testnet**; audits underway; mainnet was targeted for late summer 2026 (not confirmed yet) |
| Assets on testnet | **Two XLM pools** (verified in upstream `deployments/testnet/deployments.json` 2026-09-24: both `asset.kind: native`, same `tokenContractId`; the second adds `gvkMode: traceable`). There is **no EURC pool** — an earlier version of this row said there was | any SEP-41 token (USDC via the SAC) |
| Code | `NethermindEth/stellar-private-payments` — Apache-2.0, circuit compiler GPLv3; npm `stellar-private-payments` 0.1.0 (alpha), Rust SDK | `OpenZeppelin/stellar-contracts` |

Both rest on protocol upgrades already live on mainnet: X-Ray (Protocol 25, BN254 + Poseidon, Jan 22 2026) and Yardstick (Protocol 26, more BN254 host functions, May 6 2026).

**Which one matches Talise?** Talise's "shielded balances" hide the user's money from outside observers. That is **SPP**. Confidential Tokens still show who paid whom, which suits payroll and merchant settlement, not a consumer wallet's privacy promise.

## 2. Measured costs

Read from the chain on 2026-09-14, not from documentation.

| Item | Value | How measured |
|---|---|---|
| Fee per private transaction | **0.016–0.022 XLM, median 0.0174** | the 31 successful `transact` calls on Nethermind's testnet XLM pool in the last 7 days |
| In dollars | **≈ $0.003 per transaction** (XLM $0.1867) | CoinGecko, 2026-09-14 |
| CPU per transaction | up to **82.5M instructions** | same transactions |
| Mainnet limit | **400M instructions per transaction** | mainnet config setting, read over RPC |
| SDK download | npm tarball **42 MB** (95 MB unpacked); one pool's circuit ≈ **12 MB** (8.1 MB r1cs + 4.1 MB proving key for the block-list pool) | `npm pack --dry-run` |

One `transact` covers a shield (deposit), a private send, or an unshield (withdraw). A user who shields once, sends privately ten times and unshields once in a month costs **~0.21 XLM ≈ $0.04**, which Veil sponsors like every other fee. The fees are negligible.

## 3. What Veil would have to build

| Work | Estimate | Why |
|---|---|---|
| **Keys from the passkey** | ~1 week | SPP derives a user's note and encryption keys from a wallet signature over `"Privacy Pool Key Derivation [v1]"`. Veil has no Freighter, but it has the PRF-derived spending key on every device, and signing with it is deterministic, so private keys would come back with the passkey on recovery. Passkeys without PRF (e.g. Samsung Pass) would lose private notes on a new device, the same gap `CONTRACTS_V2.md` §8 already tracks. |
| **Web wallet** | 2–3 weeks | Browser SDK (WASM prover, SQLite on OPFS) with our signer in place of Freighter. |
| **Mobile** | 3–4 weeks (WebView), or 6–8 weeks (native) | **The hard part.** React Native's Hermes engine has no WebAssembly, so the browser SDK cannot run as is. Either run it in a hidden WebView, or wrap the Rust SDK (arkworks, parallel proving on native) in a native module. Both need the ~12 MB circuit downloaded on first use. |
| **Private balance sync** | 1–2 weeks + hosting | Notes are found by scanning pool events, and RPC keeps only **7 days**. Anyone joining later needs a bootnode with the full history. Nethermind runs a dev one (`bootnode.dev-nethermind.xyz`); for mainnet, Veil runs its own (Wraith is the natural home, though it indexes testnet only and its database is over the free tier) or relies on theirs. |
| **UX** | 2–3 weeks | Private balance, shield / private send / unshield flows, selective disclosure ("prove this payment to my bank"). |
| **Total** | **~9–15 engineer-weeks** | Web + mobile via WebView. Native mobile adds ~3–4 weeks. |

Deposits would come from the spending account, as Earn's do; the pool pulls tokens with that account's signature, so no contract change is needed on our side.

## 4. Costs we avoid, and the ones we would take on

**Avoided by integrating instead of building.** `SCF_STRATEGY.md` §6 planned a fork of `soroban-privacy-pools`: our own circuits, our own trusted-setup ceremony, our own pool contracts, and an audit of all of it. SPP replaces that. A ZK audit is the expensive line: on the market, ZK circuit audits run **80–120% above** an equivalent EVM audit, where mid-complexity DeFi is **$40k–$100k** (Sherlock, 2026).

**If Veil deployed its own pool anyway** (not recommended):

- **Deploy fees:** instantiating Nethermind's testnet pools cost ~0.9 XLM. The Wasm uploads were not in the scanned ledgers; our own uploads cost 33.3 XLM (wallet) and 5.95 XLM (factory), so expect tens of XLM for SPP's five contracts. This is an estimate.
- **Audit:** the Soroban Audit Bank covers **up to 100%** of an audit for SCF-funded projects. The **5% co-pay** is refunded if critical, high and medium findings are fixed within 20 business days. It requires near-mainnet-ready code and a STRIDE threat model, and its rules do not say whether ZK circuits are in scope.
- **Weaker privacy:** a pool is only as private as the crowd in it. A Veil-only pool with a few hundred users hides far less than a shared SDF/Nethermind pool, so **use the canonical mainnet pool when it exists**.

**Taken on either way:**

- **Compliance role.** Pools are gated by an Association Set Provider (allow/block lists) and can freeze notes; view keys should sit in MPC or TEE custody, not in an app. Using the canonical pool leaves those roles with its operator; running a pool makes them ours.
- **Legal review before mainnet.** `NGN_RAILS.md` already records that "we're just the tech layer" is not a safe position in Nigeria. A privacy feature draws more scrutiny, not less, and the compliant design (KYC gating, disclosure) is what makes it defensible. Cost unknown until we ask counsel.
- **Licence notices.** The circuit compiler is GPLv3 and compiled artifacts carry notice obligations; ship the NOTICE files with the app.

## 5. Recommendation

1. **Now, free:** join the SPP developer preview on testnet. Prototype passkey-derived keys and one private send in the web wallet, which proves the integration before any mobile spend.
2. **SCF application:** replace "fork-and-harden `soroban-privacy-pools`, trusted setup" with **"integrate Stellar Private Payments"**: passkey-derived privacy keys, mobile prover, bootnode, private-balance UX. That is less risk and sits on the ecosystem's own standard, and it is still the Tranche 2 testnet deliverable. Budget the ~9–15 weeks plus bootnode hosting; audit through Audit Bank.
3. **Mainnet:** only after SPP is audited and SDF approves it, using the canonical pool, after a legal review.

## Sources

- Stellar Docs, Privacy on Stellar — https://developers.stellar.org/docs/build/apps/privacy
- Stellar blog, Developer Preview: Stellar Private Payments — https://stellar.org/blog/developers/developer-preview-stellar-private-payments
- Stellar blog, Developer Preview: Confidential Tokens — https://stellar.org/blog/developers/developer-preview-confidential-tokens-on-stellar
- Stellar blog, strategy for privacy — https://stellar.org/blog/ecosystem/strategy-for-privacy-on-blockchain
- Nethermind blog, Stellar Private Payments — https://www.nethermind.io/blog/stellar-private-payments-confidential-and-compliant-transfers-on-public-rails
- NethermindEth/stellar-private-payments (README, ARCHITECTURE.md, sdk/native, deployments/testnet) — https://github.com/NethermindEth/stellar-private-payments
- Stellar developer meeting 2026-08-06 — https://developers.stellar.org/meetings/2026/08/06
- Protocol 25 X-Ray — https://stellar.org/blog/developers/announcing-stellar-x-ray-protocol-25
- Protocol 26 Yardstick — https://stellar.org/blog/foundation-news/yardstick-stellar-protocol-26
- CryptoTimes, Confidential Tokens — https://www.cryptotimes.io/2026/06/30/stellar-launches-confidential-tokens-for-private-sep-41-balances/
- Soroban Audit Bank rules — https://stellar.gitbook.io/scf-handbook/supporting-programs/audit-bank/official-rules
- Sherlock, audit pricing 2026 — https://sherlock.xyz/post/smart-contract-audit-pricing-a-market-reference-for-2026
- Talise — https://www.talise.io/
