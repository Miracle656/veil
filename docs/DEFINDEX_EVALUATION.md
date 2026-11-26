# DeFindex evaluation — vault layer for wallets, or a wrapper around our pool?

**Issue:** #1304 · **Related:** #1277 (yield account), #1280 (USDT0), restaking epic
**Measured:** 2026-11-21, 10:36–11:25 UTC, Stellar mainnet ledgers ~65,594,789–65,594,821
**Recommendation:** **Decline**, for USDC and for every asset DeFindex currently offers. Conditions for revisiting are at the end.

Every number below is dated and comes from one of four sources. Each is named where it is used.

| Source | What it gives | Read at (UTC) |
|---|---|---|
| Soroban RPC (`mainnet.sorobanrpc.com`): contract instance storage, simulated read calls, Blend pool state through `@blend-capital/blend-sdk` | vault roles, fees, upgradability, allocations; the strategy's Blend position; Blend APY | 11:18–11:25 |
| Horizon (`horizon.stellar.org/accounts/<G…>`) | signer thresholds of every role account | 11:20 |
| DeFindex API: [`/vault/discover`](https://api.defindex.io/vault/discover?network=mainnet), [`/strategies`](https://api.defindex.io/strategies?network=mainnet) | the vault and strategy registry, realised strategy APY | 11:18 |
| DefiLlama: [`/protocol/defindex`](https://api.llama.fi/protocol/defindex) | protocol TVL by token | 10:36 |

DeFindex contract source was read at [`defindex-io/stellar-contracts@529f7c5`](https://github.com/defindex-io/stellar-contracts/tree/529f7c5006387e8c59c8d68014ff87761b8a3490), cited below as `SRC`.

---

## 1. TVL and strategy distribution: the concentration is still there, and it is higher

**Total TVL (DefiLlama, 10:36 UTC): $18,148,980.** By token:

| Token | USD | Share |
|---|---:|---:|
| USDC | 18,134,742.57 | **99.92%** |
| EURC | 13,755.32 | 0.08% |
| CETES | 461.74 | <0.01% |
| XLM | 20.68 | <0.01% |

**By strategy (on-chain).** The USDC Blend Fixed strategy
`CDB2WMKQQNVZMEBY7Q7GZ5C7E7IAFSNMZ7GGVD6WKTCEWK7XOIAVZSAP` holds **18,259,765.17 USDC** in the Blend Fixed pool `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD`. That was read directly from the pool (`loadUser(strategy)`), not from DeFindex's API. Its stored config (`Config.pool`) is the same pool ID Veil uses in `frontend/mobile/lib/blend.ts`.

| Strategy (API `/strategies`, 11:18 UTC) | Asset | TVL (asset units) |
|---|---|---:|
| `blend_autocompound_fixed` (`CDB2WMKQQNVZMEBY7Q7GZ5C7E7IAFSNMZ7GGVD6WKTCEWK7XOIAVZSAP`) | USDC | **18,259,730.67** |
| `eurc_blend_autocompound_fixed` | EURC | 13,526.48 |
| `cetes_blend_autocompound_etherfuse` | CETES | 2,171.61 |
| `tesouro_blend_autocompound_etherfuse` | TESOURO | 1,107.68 |
| `xlm_blend_autocompound_fixed` | XLM | 267.82 |
| `ustry_blend_autocompound_etherfuse` | USTRY | 140.68 |
| `blend_autocompound_yieldblox` | USDC | 95.32 |
| `usdc_blend_autocompound_etherfuse` | USDC | 7.07 |
| 9 others (YieldBlox and Orbit variants, Precept, Prism) | — | < 1 unit each, or 0 |

The non-USDC strategies come to roughly $14–16k combined. The USDC Blend Fixed strategy is therefore **≈ 99.9% of DeFindex TVL**. The dated 99.4% figure is confirmed and slightly exceeded. Of the USDC held in strategies, 99.999% sits in Blend Fixed.

Two more findings change how this should be read:

- **DeFindex is 46% of the pool Veil supplies to.** Blend Fixed USDC total supply was 39,733,021 USDC. DeFindex's strategy holds 18,259,765 of it (45.96%). DeFindex is not an alternative venue to Blend Fixed. It is the largest single depositor in it.
- **One vault is the protocol.** Of 130 vaults the factory reports (`total_vaults`), the API lists 14. One of them, **Meru** (`CCA2ZJP5BVRXYTQH4FAGHCAUMRYCXVC4CRYC2NXHWMR7TIVX36U7F5HR`), holds 17,829,154 USDC: 98.2% of protocol TVL and 97.6% of the Blend Fixed strategy. The 13 other listed vaults hold about $300k between them. Unlisted vaults hold about 146,551 USDC (strategy position minus the listed vaults' allocations).

So "aggregator" describes the contract design, not what is deployed. On mainnet today, DeFindex is one wallet's wrapper around Blend Fixed USDC.

## 2. Fee stack and net yield

### How fees work (verified in source and docs)

- There is **one fee, a performance fee on positive yield**, set per vault in bps (`VaultFee`). Fees are locked on every deposit and withdraw (`SRC vault/src/report.rs`). DeFindex charges no deposit, withdrawal or management fee ([docs: Fees and revenue](https://docs.defindex.io/intro/fees)).
- **The protocol fee is a share of the vault fee, not an extra layer.** `distribute_fees` pays `DeFindexProtocolFeeRate` of the locked fee to DeFindex's receiver and the rest to the vault's `VaultFeeReceiver` (`SRC vault/src/report.rs`). The rate is copied from the factory when the vault is created and cannot be changed afterwards. The factory default was **5000 bps (50%)** (factory storage `FeeRate`), so a vault Veil created today would split its fee 50/50 with DeFindex.
- **Cap: 9,000 bps (90%) of yield** for both the vault fee (`SRC vault/src/storage.rs:111`) and the protocol share (`SRC factory/src/constants.rs:1`). The [fees guide](https://docs.defindex.io/integration-guide/fees) says the same.
- **What Veil could take:** whatever vault fee it sets, minus DeFindex's share. Every dollar of Veil revenue costs users the same dollar plus DeFindex's cut. At the 50% default share, **for every $1 Veil earns, users give up $2 of yield.**

Observed fee configurations on mainnet (`[VaultFee, DeFindexProtocolFeeRate]` from instance storage): Meru `[1792, 2000]`, the BNS vaults `[1000, 2000]`, hana/xPortal/SVT/SEAV `[2000, 2000]`, rozo/nUSDC `[1000, 5000]`, the P* vaults `[100, 5000]`.

Meru runs DeFindex's **Stable APY** product. Its Manager is a FeeProxy contract (`CBXBQ7SI5UOCDFGUKBAQS4HIZOUSVTSJYY4L2ZJRBHIYCKDDC3PQ3QTB`) with `target_apy_bps = 500`, `min_fee_bps = 150` and `max_fee_bps = 8000`. The fee floats so that depositors receive about 5%, and everything above 5% is fee ([docs: Stable APY](https://docs.defindex.io/products/stable-apy)). At today's 6.06% gross, 1792 bps leaves depositors 4.97%, which matches the target.

### Same asset, same amount: 1,000 USDC for one year

Inputs:

- **Gross yield is the same on both paths.** The strategy supplies USDC to the same reserve in the same pool. Blend Fixed USDC `estSupplyApy` = **6.0602%** (utilisation 79.98%, read 11:25 UTC). The USDC reserve paid no supply-side BLND emissions at that moment, so the strategy's autocompounding adds nothing.
- The strategy's realised APY from the API (7-day 6.37%, 30-day 5.98%) is consistent with the pool rate. Both are measured before the vault fee.
- Rates are held constant for the year. Compounding is the same on both paths (Blend accrues through `b_rate`), so it is left out.

| Path | Vault fee | Protocol share | User nets | Veil earns | DeFindex earns | User vs direct |
|---|---:|---:|---:|---:|---:|---:|
| **Direct Blend supply (today's Veil)** | — | — | **60.60 USDC (6.06%)** | 0 | 0 | — |
| DeFindex, Veil vault at 10% | 1000 bps | 50% | 54.54 (5.45%) | 3.03 | 3.03 | −6.06 |
| DeFindex, Veil vault at 20% | 2000 bps | 50% | 48.48 (4.85%) | 6.06 | 6.06 | −12.12 |
| DeFindex, Meru today (Stable APY) | 1792 bps | 20% | 49.74 (4.97%) | (Meru: 8.69) | 2.17 | −10.86 |
| DeFindex at the 90% cap | 9000 bps | 50% | 6.06 (0.61%) | 27.27 | 27.27 | −54.54 |

For USDC, every DeFindex configuration nets the user strictly less than what Veil already gives them. The only difference is the fee. The underlying risk is identical too, since it is the same Blend pool, and on top of it sit the vault contract, the strategy contract and the strategy's keeper. Withdrawal liquidity is no better: a vault withdrawal unwinds from the same Blend reserve, at the same 80% utilisation.

## 3. Governance: who can move funds, and with what delay

### Roles (SRC `vault/src/access.rs`; [docs: Vault Roles](https://docs.defindex.io/integration-guide/vault-roles))

Every role is a single `Address`, enforced by `require_auth()` (`access.rs:43`, `:52`).

| Power | Manager | Rebalance Mgr | Emergency Mgr | Delay |
|---|:-:|:-:|:-:|---|
| `rebalance`: unwind/invest across the vault's whitelisted strategies, swap between vault assets (`lib.rs:846`) | ✅ | ✅ | — | **none** |
| `rescue`: pull everything out of a strategy into idle and pause it (`lib.rs:431`) | ✅ | — | ✅ | **none** |
| `lock_fees(new_fee_bps)`: change the fee (≤ 90%) and apply it at once to gains not yet locked (`lib.rs:972`) | ✅ | — | — | **none** |
| `upgrade`: replace the vault's WASM, if the vault was deployed upgradable (`lib.rs:822`) | ✅ | — | — | **none** |
| `set_manager`, `set_rebalance_manager`, `set_emergency_manager`, fee receiver | ✅ | — | — | **none** |

- **Timelock: confirmed absent.** No timelock, delay, queue/execute or timestamp check exists in `vault/src` or `factory/src`. The only ledger-sequence check is token-allowance expiry. Every power above takes effect in the transaction that authorises it.
- **Native multisig: confirmed not required.** The contract accepts any address. DeFindex's docs *recommend* "a multisig wallet or a policy-based smart contract" for Manager and Rebalance Manager, and that recommendation is the only safeguard.
- **What a manager cannot do.** It cannot call a transfer of user funds to itself. Rebalancing is limited to strategies fixed at construction, and swaps go only between the vault's own assets. Withdrawals cannot be frozen. The docs ([Risks and Audits](https://docs.defindex.io/advanced-documentation/risks-and-audits)) and the source agree on this. **The exception is `upgrade`.** On an upgradable vault, the Manager can replace the code wholesale, with no delay, and new code can do anything, including transferring funds out. In the docs' own words, upgrading is "the one path that can change" the guarantees. `Upgradable` is fixed at construction, and `is_upgradable` defaults to `true` (`storage.rs:177`).

### What is actually deployed (instance storage + Horizon, 11:20 UTC)

| Vault | USDC held | Upgradable | Manager | Rebalance Manager |
|---|---:|:-:|---|---|
| **Meru** | **17,829,154** | **yes** | FeeProxy contract; its per-vault admin is `GAYBFYMAQU7GSHSHNX7RBUE2KSSRQBME7XHP5BONAVKXI5BSUOQXTWPL`, **single key** | `GAYBFYMAQU7GSHSHNX7RBUE2KSSRQBME7XHP5BONAVKXI5BSUOQXTWPL`, **single key** |
| BNS USDC | 250,529 | yes | `GC5ZV3VZZEZHFU7YH6YAOEPONSTGFVRO7V64H6X2MFXRZH6QLC5OFLYP`, 2-of-3 | same |
| USDC-SEAV | 14,160 (idle) | no | `GC5ZV3VZZEZHFU7YH6YAOEPONSTGFVRO7V64H6X2MFXRZH6QLC5OFLYP`, 2-of-3 | `GB3W56BWDAFN37AE5FUUUW3Y5K3H7RKIFHF52JCKEEGXFKPBGQRDHMIA`, single key |
| xPortal | 13,418 | yes | `GDQ4HYM5GRYMZX754BWXLCCE5UKNWVVLS2OEP5WNG6NXR6N4NWXA6QYA`, single key | same |
| nUSDC | 8,257 | no | `GBPH7PWUDCTRDTC2GIEKSLINSNE754FGO26RIX5B7F6DDRNLG6MKOTDW`, single key | same |
| SVT | 8,064 | yes | `GAFCZUU7533X6GRCUGQOQTWRIYANGE5IQXHAZ7ZXKJXFECYF2TOCMK2O`, 2-of-3 (low threshold 0) | same |
| hana | 7,375 | no | `GBDEH6C5UICDFKU5CCSM7INYG6TQBVZRTJ7NRWH5NYVHA4EPAPBSE4M2`, single key | same |
| rozo | 4,761 | no | `GC56BXCNEWL6JSGKHD3RJ5HJRNKFEJQ53D3YY3SMD6XK7YPDI75BQ7FD`, single key | same |

"Single key" means Horizon thresholds of 0 or 1 with one effective signer. Every address in this table is written in full, so it can be pasted straight into `https://horizon.stellar.org/accounts/<address>`.

**The decisive finding.** The vault holding 98% of DeFindex TVL is upgradable. Its Rebalance Manager, and the admin through which its upgrade authority is exercised, is one single-signer account. That account can do all of the following now, in one transaction, with no delay:

- move all 17.8M USDC into the vault's other whitelisted strategy, `blend_autocompound_yieldblox`, which is **unpaused** on Meru;
- raise the fee: Meru's current bounds already allow up to 80% of yield, and the per-vault admin can change the bounds;
- replace the vault's code.

The FeeProxy is DeFindex's Stable APY contract. Its ABI exposes `upgrade_vault`, `rescue_vault`, `set_vault_manager`, `set_fee_bounds`, `set_target_apy` and `propose_admin`/`accept_admin`, and nothing that queues or delays an action. DeFindex's docs say that only the registered admin can upgrade the vault through it. The FeeProxy source is not in `stellar-contracts`, so its auth rules are taken from the [Stable APY docs](https://docs.defindex.io/products/stable-apy) and the Runtime Verification audit listing, not from source. The proxy's own admin (`GD6MNC3WFIZ6HSSUTYWEHJCFFNHR4Z6XX3NF6V2254NLQAJFZXEIBZF5`) and fee manager (`GCED56ZG7NMCZBYI6THE6KQNUYTBJPCSITDY75LIK3426PRCH2XC547G`) are also single-key accounts, as are the factory admin (`GAJZKZVWJ237N23KAGBRIFNVE7KOUF27OTIKQPXF3TIJEGYM776WL35P`) and the Blend strategy's keeper (`GC7LSNNCRW4PNLLHIXE53RB7N5BKSQVXTGWYHIYBA7LAWY7XYPC4JGCP`). DeFindex's protocol fee receiver (`GCTQL76FD4EHJJ6V7NQO4BA2CHRALBLEVPD5EANNQYIOZLO3LIW7EAQ6`) is a 2-of-3.

**Could Veil fix this by running its own vault?** Partly. A Veil-created vault could be **non-upgradable**, which removes the code-replacement path permanently. Its Manager and Rebalance Manager could be a Veil multisig or policy contract, and Veil could wrap them in its own timelock contract, since any role can be a contract. That is all custom work Veil would build, audit and operate. DeFindex provides none of it. Even then, Veil would still hold a key that can redirect users' allocations and raise their fee to 90% instantly unless Veil's own contract stops it. If the vault has only Blend Fixed as its strategy, the manager has nothing meaningful to rebalance into, and the result is the pointless wrapper again: same pool, plus a fee.

## 4. Audit status of the contracts Veil would call

| Contract Veil would touch | Audit | Link |
|---|---|---|
| DeFindex Vault, Factory, Blend Autocompound strategy | **OtterSec, Feb 7 – Mar 10 2025**, commit `cde2493`. 16 findings: 1 critical (bRate precision manipulation), 3 high, 2 medium, 7 low, 3 informational. All 13 non-informational findings are marked Resolved. | [report](https://github.com/defindex-io/stellar-contracts/blob/main/docs/audits/2025_03_18_ottersec_defindex_audit.pdf) |
| Stable APY FeeProxy, Boost, BoostTreasury (Meru's manager) | **Runtime Verification, 2026-07** (listed by DeFindex; the report was not reviewed for this document) | [report](https://github.com/runtimeverification/publications/blob/main/reports/smart-contracts/DeFindex%20APY%20Stabilizer-Audit%20Report-Final.pdf) |
| Kinetic Autocompound, RWA Wrapper strategies | Halborn, Aug 17–20 2026, commit `cdce87d`. Not contracts Veil would call for USDC. | [report](https://github.com/defindex-io/stellar-contracts/blob/main/docs/audits/2026_09_07_halborn_stellar_strategies_audit.pdf) |
| Blend V2 pool (underlying) | Blend's own audits; Veil already depends on these | [Blend audits](https://docs.blend.capital/audits-and-bug-bounties#v2-audits) |

**Gap:** the vault WASM deployed on mainnet (`ae3409a4…468b`, which is also `vault_wasm_hash` in the factory) has **not** been tied to the audited commit. The OtterSec audit covers `cde2493` plus the listed fix commits. Code changed after March 2025 (for example the strategy-facing behaviour and the fee-rate copy described in the current docs) is not covered unless a reproducible build of an audited commit produces `ae3409a4…`. Nobody has shown that, including this evaluation.

## 5. Are vault shares transferable SEP-41 tokens?

**Yes.** The vault is itself the share token. It implements `balance`, `transfer`, `transfer_from`, `approve`, `allowance`, `burn`, `burn_from`, `decimals`, `name` and `symbol` (`SRC vault/src/token/contract.rs`). DeFindex's docs state that dfTokens "are transferable, just like any other Stellar token" ([guide](https://docs.defindex.io/integration-guide/guides-and-tutorials/deposit-and-transfer-dftokens)). For the restaking epic, this means a DeFindex share could be deposited elsewhere. It also means the share inherits all of the vault's manager and upgrade risk above, wherever it ends up.

## 6. Does a USDT0 strategy exist? (#1280)

**No. None found.** Checked against:

- the official strategy registry (`/strategies?network=mainnet`, 16 entries: USDC, EURC, XLM, CETES, USTRY, TESOURO);
- the 14 discoverable vaults' assets;
- `public/mainnet.contracts.json`;
- the full DeFindex documentation (`docs.defindex.io/llms-full.txt`, zero matches for "usdt").

The Blend Fixed pool itself has only XLM, USDC and EURC reserves, so there is nowhere for a Blend Fixed USDT0 strategy to supply. DeFindex does not settle #1280. The canonical USDT0 SAC is `CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF` (see `scripts/wave-issues-usdt0.md`), and it has no DeFindex route.

## 7. Recommendation: decline

1. **USDC: decline.** DeFindex's USDC TVL is ≈ 99.9% in Blend Fixed, the pool Veil already supplies to directly. Integrating it inserts a vault contract, a strategy contract, a keeper and a fee between users and the same reserve. Users net 6.06% directly and 4.85–5.45% through a Veil vault at a 10–20% fee. Any revenue Veil takes costs users twice that, because DeFindex keeps an equal share at the default split.
2. **EURC and XLM: decline, for the same reason.** Their DeFindex strategies also supply Blend Fixed.
3. **CETES/USTRY/TESOURO (Etherfuse) and future venues: not now.** These are the only strategies that reach somewhere Veil does not. Their TVL is a few thousand dollars, Veil does not offer those assets, and adopting them would bring every governance problem below with no proven demand.
4. **The deciding question is answered against adoption.** The protocol enforces no timelock and no multisig. On an upgradable vault the Manager can replace the code outright, and the vault holding 98% of DeFindex's money is upgradable and governed by a single-signature key. To offer DeFindex responsibly, Veil would have to deploy a non-upgradable vault, hold its Manager behind a Veil-built multisig-plus-timelock contract, and carry that key on users' behalf, all to wrap a pool it already reaches. That is the issue's "worse than pointless" case, avoidable only through custom work that removes the reason to use DeFindex.

### What would change this

Revisit if **all** of the following become true:

- DeFindex offers a strategy for an asset or venue Veil cannot reach directly and users want, for example a USDT0 lending market. This settles #1280 if it happens.
- The vault Veil would use is deployed `upgradable = false`.
- Manager and Rebalance Manager are held by a timelocked multisig or policy contract, either native to DeFindex or built and audited by Veil, with a delay long enough for users to exit.
- The deployed vault WASM is shown, by reproducible build, to match an audited commit.

## How to reproduce

- **TVL by token:** `curl https://api.llama.fi/protocol/defindex`, then read `currentChainTvls` and the latest `chainTvls.Stellar.tokensInUsd` entry.
- **Strategies and vaults:** `curl 'https://api.defindex.io/strategies?network=mainnet'` and `curl 'https://api.defindex.io/vault/discover?network=mainnet'`.
- **Vault roles, fees and upgradability:** read the vault's contract-instance ledger entry (`getLedgerEntries`, key `ScVal::LedgerKeyContractInstance`) and decode the `Manager`, `RebalanceManager`, `EmergencyManager`, `VaultFee`, `DeFindexProtocolFeeRate` and `Upgradable` keys. Or simulate `get_manager`, `get_rebalance_manager`, `get_fees` and `fetch_total_managed_funds`.
- **Signer thresholds:** `curl https://horizon.stellar.org/accounts/<G…>`, then read `thresholds` and `signers`.
- **Strategy position in Blend Fixed:** with `@blend-capital/blend-sdk`, call `PoolV2.load(mainnet, 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD')`, then `pool.loadUser('CDB2WMKQQNVZMEBY7Q7GZ5C7E7IAFSNMZ7GGVD6WKTCEWK7XOIAVZSAP').getSupplyFloat(usdcReserve)`.
- **Meru's Stable APY config:** simulate `get_vault_config(CCA2ZJP5BVRXYTQH4FAGHCAUMRYCXVC4CRYC2NXHWMR7TIVX36U7F5HR)` on `CBXBQ7SI5UOCDFGUKBAQS4HIZOUSVTSJYY4L2ZJRBHIYCKDDC3PQ3QTB`.

All on-chain figures change every ledger. Re-measure before quoting them anywhere else.
