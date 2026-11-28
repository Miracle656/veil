# Stellar Yield Venues and Movable Receipts

**Research date:** 2026-11-21

## Summary

Veil's existing savings route is the Blend Fixed V2 lending pool
`CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD`. Its supply
receipts are pool-accounting bTokens: they accrue interest, are not transferable
tokens, and cannot be reused as collateral or deposits in another venue.

The first material concentration finding is that DeFindex's reported USDC
strategy TVL is overwhelmingly in the Blend Fixed strategy. On 2026-11-21,
that strategy reported `182062302414551` USDC stroops
(`18206230.2414551` USDC) against `182063326280477` USDC stroops total across
DeFindex USDC strategies; the Fixed strategy was therefore 99.9994%. The older
99.4% claim is not off in direction, but is less concentrated than the current
USDC-strategy data.

For savings, the clearest existing route is direct Blend Fixed V2. DeFindex
adds a wrapper and management layer, while Gami earnUSDC is a separate
curated Upshift vault. Soroswap, Aquarius, Slender, Templar, and classic
liquidity pools are not interchangeable with lending positions.

## Method

Verification used three evidence classes:

1. The repository's current Earn, Blend, Soroswap, and asset integrations.
2. Protocol documentation and official source repositories.
3. Live mainnet reads:
   - public Soroban RPC at `https://mainnet.sorobanrpc.com`;
   - contract-instance ledger reads on 2026-11-21;
   - DeFindex public strategy/discovery APIs;
   - Upshift public vault listing API;
   - Aquarius public AMM API.

A Soroban contract ID is recorded as verified only when an official source
named it and a mainnet contract-instance ledger read returned `EXISTS`, or a
live protocol API returned it and the corresponding public method was
confirmed. Missing official mainnet IDs are not guessed.

## Comparison table

| Venue | Mainnet contracts / IDs | Receipt | Transferable? | Exit | Failure mode |
|---|---|---|---|---|---|
| Blend Fixed V2 | Pool `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD`; backstop `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7`; USDC SAC `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | bToken accounting entry plus address position; dToken if borrowed | No; protocol docs call b/dTokens non-transferable accounting positions | Instant `withdraw()` subject to pool status and available liquidity | Utilization, bad debt, frozen/on-ice pool status, oracle failure, liquidation, smart-contract risk |
| Blend backstop | Backstop `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7`; backstop token `CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM` | Backstop shares recorded by the pool and address | No standalone share-token transfer; shares are contract accounting entries | Queue then withdraw after 17 days; cancellation releases the queue | Pool bad debt can reduce share value; emissions stop while queued; contract/queue/administration risk |
| DeFindex | Example vault `CBNKCU3HGFKHFOF7JTGXQCNKE3G3DXS5RDBQUKQMIIECYKXPIOUGB2S3`; Fixed strategy `CDB2WMKQQNVZMEBY7Q7GZ5C7E7IAFSNMZ7GGVD6WKTCEWK7XOIAVZSAP`; factory ID UNVERIFIED | Vault dfTokens/shares | Yes; official docs state dfTokens implement the Stellar token interface and can be transferred | No fixed queue documented; withdrawals depend on vault and underlying-strategy liquidity | Strategy loss, paused strategy, withdrawal slippage, vault/role risk, liquidity shortage, fee/upgrade risk |
| Soroswap AMM | Factory `CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2`; router `CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH`; aggregator `CARVQXFP4JF5ELLXUMQ6DALR346YVGBMQOHB4ENA7SSVXAYABXLBDDC4`; pair IDs depend on the pair and are UNVERIFIED here | Pair LP receipt implementing the Stellar token interface | Yes for an actual deployed pair; pair-specific interface/receipt ID must be read | Remove liquidity when reserves can fill; otherwise liquidity-dependent | Impermanent loss, price/slippage risk, thin liquidity, bad route, pool contract risk |
| Aquarius AMM and AQUA/ICE | AQUA issuer `GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA`; pool-venue contract IDs UNVERIFIED; ICE lock contract/asset ID UNVERIFIED | AMM share token; ICE receipt for locked AQUA | AMM pool shares: UNVERIFIED at the exact-contract level; official pool API exposes a `share_token_address` per pool; ICE: UNVERIFIED | AMM: liquidity-dependent remove-liquidity; ICE: exact unlock/expiry mechanics UNVERIFIED | Thin pools, impermanent loss, reward volatility, lock duration/exit risk, vote-lock and contract risk |
| Slender | Pool `CCL2KTHYOVMNNOFDT7PEAHACUBYVFLRH2LYWVQB6IPMHHAVUBC7ZUUC2`; sToken USDC `CA5RXZCRGH7HCACUBO6M57E2CMEF35JVFPQWJ6LBA336WQUSFH7YFTT6`; sToken XLM `CAUE3RVG6QPXZJHHI6VW24SCCRA2DIYEDAAPSUGZ2PRPCF6EM74U3CUU`; debt-token interfaces are separate | sToken supply receipt; debt token for borrowing | Supply sToken has `transfer`/`approve`/`balance` in the official binding; debt-token binding has no transfer entrypoint | Withdraw subject to pool reserve liquidity and protocol state | Reserve depletion, frozen pool, bad debt/liquidation, oracle risk, contract risk |
| Templar | UNVERIFIED | UNVERIFIED; lending protocol position receipt not established here | UNVERIFIED | UNVERIFIED | UNVERIFIED: oracle, collateral, liquidation, contract and liquidity risks must not be inferred |
| Gami earnUSDC / Upshift | Vault `CCL3WITWFFXIHV2I52ECV5DPIEOFSTU3PBPR53ILPLF2IP5KHECXRUTY` | Fungible ERC-4626-style vault share token (`earnUSDC`) | Yes at the share-token level according to Upshift's Stellar fungible-share architecture; exact transfer entrypoint/approval should be read onchain | Redeem if the vault's local USDC balance can fill; no fixed queue in Upshift Stellar docs | Curator/strategy loss, paused operations, liquidity wait, fee, upgrade, custody and smart-contract risk |
| Stellar classic liquidity pools | No central Soroban contract ID; each pair has a protocol Liquidity Pool ID/share asset | Classic liquidity-pool share asset | No: protocol shares cannot be sent in payments or sold in offers | Add liquidity; remove-liquidity operation when the pool is usable | Impermanent loss, thin liquidity, failed pool operations, counterparty asset risk |

## Per-venue evidence

### 1. Blend lending and Fixed V2

The repo selects
`CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD` as the mainnet
Blend pool in `frontend/wallet/lib/blend.ts`. Veil loads `PoolV2` and reads
supply positions through `loadUser(userAddress)`, which is consistent with
`get_positions(address)`.

Verified mainnet reads on 2026-11-21 returned the pool contract instance and
resolved the pool's backstop contract
`CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7`. The same pool
metadata resolved the USDC token, backstop token and pool factory.

Evidence:

- [Blend protocol tokens](https://docs.blend.capital/tech-docs/core-contracts/lending-pool/protocol-tokens.md):
  b/dTokens are non-transferable accounting positions.
- [Blend fund management](https://docs.blend.capital/tech-docs/core-contracts/lending-pool/fund-management.md):
  deposit and withdrawal requests, pool freeze/on-ice conditions.
- [Blend Fixed pool on Stellar Expert](https://stellar.expert/explorer/public/contract/CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD).
- [Blend backstop on Stellar Expert](https://stellar.expert/explorer/public/contract/CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7).

Exit is a pool withdrawal, not a token transfer. It is instant while the pool
is usable and enough reserve liquidity exists, subject to pool status and
oracle/collateral constraints.

### 2. Blend backstop

Blend's official deposit-management documentation states:

- deposits create backstop shares;
- share value rises with pool interest and falls when deposits cover bad debt;
- withdrawals are queued for 17 days;
- emissions stop while queued;
- pool interest continues while queued;
- `cancel_withdrawal()` reverses the queue.

Evidence:

- [Blend backstop deposit management](https://docs.blend.capital/tech-docs/core-contracts/backstop/deposit-management.md)
- Contract instance read: `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7`
- [Pool metadata backstop result](https://stellar.expert/explorer/public/contract/CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7)

The backstop is a first-loss position. Share value can fall. The queue length
is not assumed to be configurable here: official current docs state 17 days.

### 3. DeFindex

Official DeFindex docs describe dfTokens as vault shares, minted on deposit,
transferable, and redeemable for underlying assets. The vault itself is the
dfToken contract and implements the standard Stellar token interface.

Live mainnet evidence on 2026-11-21:

- Vault example:
  `CBNKCU3HGFKHFOF7JTGXQCNKE3G3DXS5RDBQUKQMIIECYKXPIOUGB2S3`,
  verified as a live contract instance.
- Fixed Blend strategy:
  `CDB2WMKQQNVZMEBY7Q7GZ5C7E7IAFSNMZ7GGVD6WKTCEWK7XOIAVZSAP`,
  verified as a live contract instance and returned by DeFindex `/strategies`.
- The factory address was not retrievable without credentials in this
  environment. **UNVERIFIED.**

Evidence:

- [DeFindex vaults](https://docs.defindex.io/products/vaults.md)
- [dfToken transfer guide](https://docs.defindex.io/integration-guide/guides-and-tutorials/deposit-and-transfer-dftokens.md)
- [Vault methods](https://docs.defindex.io/advanced-documentation/direct-contract-calls/vault-methods.md)
- [DeFindex vault discovery API](https://api.defindex.io/vault/discover?network=mainnet)
- [DeFindex strategies API](https://api.defindex.io/strategies?network=mainnet)
- [Example vault on Stellar Expert](https://stellar.expert/explorer/public/contract/CBNKCU3HGFKHFOF7JTGXQCNKE3G3DXS5RDBQUKQMIIECYKXPIOUGB2S3)

DeFindex has no fixed queue stated in its vault documentation. Exit is
liquidity-dependent across the vault and underlying strategies.

### 4. Soroswap

Official Soroswap documentation says pair contracts implement the Stellar token
interface and the protocol is a constant-product AMM. The repository routes
through the Soroswap SDK and requests SOROSWAP, PHOENIX, AQUA, and SDEX
protocols.

Verified via the live Soroswap SDK contract-address API on 2026-11-21:

- Factory:
  `CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2`
- Router:
  `CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH`
- Aggregator:
  `CARVQXFP4JF5ELLXUMQ6DALR346YVGBMQOHB4ENA7SSVXAYABXLBDDC4`

All three returned `EXISTS` from mainnet contract-instance ledger reads.
Specific pair contract IDs remain pair-dependent and were not enumerated.

Evidence:

- [Soroswap AMM](https://docs.soroswap.finance/amm.md)
- [Soroswap supported venues](https://docs.soroswap.finance/aggregator/supported-amms.md)
- [Soroswap technical reference](https://docs.soroswap.finance/amm/technical-reference)
- Repo integration: `frontend/wallet/lib/soroswap.ts`

Adding liquidity creates pair shares. Removing liquidity is the exit and is
subject to current reserves and slippage.

### 5. Aquarius

Aquarius's live AMM API returned pool metadata and a per-pool
`share_token_address`. A live sample pool was
`CANVVFXNIB7JKXLO2QB74BPQIBOSE73G7ABAQDU5FJQ4XOYTGVUOVDVN`; it reported
the same value for `share_token_address`, as of 2026-11-21. A mainnet
Soroban ledger read on 2026-11-21 returned `EXISTS` for that pool contract.
Horizon also returned the AQUA asset under issuer
`GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA`.

The transfer interface for that exact pool was not established in this pass.
The exact AQUA ICE locker contract or ICE receipt contract is also **UNVERIFIED**.

Evidence:

- [Aquarius website](https://aqua.network)
- [Aquarius AMM pool API](https://amm-api.aqua.network/pools/?format=json&size=1)
- [Aquarius official GitHub organization](https://github.com/AquariusDeFi)
- Repo-registered AQUA issuer:
  `GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA`

The pool exit is liquidity-dependent. Vote-locking and ICE expiry, unlocking,
and transfer mechanics were not verified from a source contract or live
interface.

### 6. Slender

The official Slender frontend repository publishes these mainnet values. Mainnet
Soroban ledger reads on 2026-11-21 returned `EXISTS` for the pool and each
representative receipt contract below.

- Pool:
  `CCL2KTHYOVMNNOFDT7PEAHACUBYVFLRH2LYWVQB6IPMHHAVUBC7ZUUC2`
- USDC sToken:
  `CA5RXZCRGH7HCACUBO6M57E2CMEF35JVFPQWJ6LBA336WQUSFH7YFTT6`
- XLM sToken:
  `CAUE3RVG6QPXZJHHI6VW24SCCRA2DIYEDAAPSUGZ2PRPCF6EM74U3CUU`
- USDC debt token:
  `CCN2XWUKHWMWCBNZXZRV4WADAVBHX2EMMHEGVAH2NV2DMZ3IH3K7FITL`
- XLM debt token:
  `CDIYQMQGHX7GSTF2I46K7SDNM5XXDH4PVVKXD37EXP7WNOT4D3SRYPNV`
- XRP sToken:
  `CD677VJOOQY5SMNQND7NYL64K4ZQYO24PXQSZKGTKSHXSGR2DHXWM2Q7`
- XRP debt token:
  `CB7NKQGNOY2CHE4UXHULVEWXN64WKP3H4EUOCXEV3YD2M7SBFO2MLECV`

The official sToken binding exposes `balance`, `approve`, `transfer`,
`transfer_from`, `mint`, and `burn`. The debt-token binding exposes balance,
mint, and burn, but no transfer entrypoint in the binding. Therefore supply
sTokens are interface-transferable; debt positions are not represented as
ordinary transferable debt receipts.

Evidence:

- [Slender official UI source](https://github.com/eq-lab/slender-ui)
- [Slender generated contract constants](https://raw.githubusercontent.com/eq-lab/slender-ui/main/packages/app/src/shared/stellar/constants/contracts.ts)
- [Slender sToken binding](https://raw.githubusercontent.com/eq-lab/slender-ui/main/contract-bindings/stoken/src/index.ts)
- [Slender debt-token binding](https://raw.githubusercontent.com/eq-lab/slender-ui/main/contract-bindings/debttoken/src/index.ts)

Withdrawals are subject to reserve liquidity and pool state.

### 7. Templar

Templar's public app and marketing site were reachable, but no authoritative
mainnet Soroban pool or vault contract ID was exposed in the checked app HTML
or JavaScript, and no verified official contract registry was found.

- Pool/vault contracts: **UNVERIFIED**
- Receipt: **UNVERIFIED**
- Transferability: **UNVERIFIED**
- Exit: **UNVERIFIED**

Evidence:

- [Templar Protocol](https://www.templarfi.org/)
- [Templar app](https://app.templarfi.org/)

No Templar contract or exit claim is included as a fact until the official
contract registry or read-only contract interface is available.

### 8. Gami earnUSDC / Upshift

Upshift's live mainnet vault listing returned
`CCL3WITWFFXIHV2I52ECV5DPIEOFSTU3PBPR53ILPLF2IP5KHECXRUTY` for Gami
earnUSDC. The live contract-instance ledger read returned `EXISTS` on
2026-11-21.

Upshift describes Stellar vault shares as fungible share tokens issued by the
vault contract itself, with ERC-4626-style accounting. Its redemption is
capped by the vault's local balance; if that balance is insufficient, the
curator must return capital from deployed strategies. It documents no fixed
withdrawal queue.

Evidence:

- [Upshift live vault API](https://api.upshift.finance/v1/tokenized_vaults)
- [Upshift Stellar vault architecture](https://docs.upshift.finance/vault-architecture/stellar)
- [Upshift Stellar redemption docs](https://docs.upshift.finance/sdk/stellar-actions)
- [DeFindex Gami earnUSDC strategy description](https://docs.defindex.io/strategies/gami-earnusdc.md)
- [Gami earnUSDC on Stellar Expert](https://stellar.expert/explorer/public/contract/CCL3WITWFFXIHV2I52ECV5DPIEOFSTU3PBPR53ILPLF2IP5KHECXRUTY)

Shares are fungible according to protocol architecture. Exact on-chain
`transfer` and `transfer_from` behavior for this vault was not separately
verified in this pass, although the Stellar SDK and vault interface describe
the receipt as a share token.

### 9. Stellar classic liquidity pools

Stellar classic AMMs have no central Soroban pool contract ID. A pool is
identified by its pair and has protocol-derived liquidity pool share assets.
The pool share is an account balance, not a transferable Stellar issued asset:
classic liquidity pool shares cannot be sent in payments or sold in offers.

Users enter and exit with `change_trust`-style liquidity operations:
deposit/add liquidity and withdraw/remove liquidity. Exit is available when
the protocol pool has sufficient reserves, but it is not a separate instant
selling market for the LP share itself.

Evidence:

- [Stellar list-liquidity-pools API](https://developers.stellar.org/docs/data/apis/horizon/api-reference/list-liquidity-pools)
- [Stellar liquidity pool resource](https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/liquiditypools)

No fixed pair ID is named because Veil did not route this pass to a
single verified pair.

## DeFindex concentration analysis

The 99.4% claim is directionally true for current USDC strategy TVL, and the
live 2026-11-21 result is even more concentrated:

- Fixed strategy:
  `CDB2WMKQQNVZMEBY7Q7GZ5C7E7IAFSNMZ7GGVD6WKTCEWK7XOIAVZSAP`
- Fixed TVL:
  `182062302414551` stroops, or `18206230.2414551` USDC
- All reported DeFindex USDC strategies:
  `182063326280477` stroops, or `18206332.6280477` USDC
- Fixed share:
  `99.99943763197844%`

The public `/vault/discover` response was also queried. It reported
`180820795325442` USDC stroops across its 14 vault rows, while the strategy
API reported a larger Fixed strategy TVL. The two surfaces are not exactly
reconciled at the same cache snapshot, so the precise absolute cross-surface
TVL is not used as a final number.

For the strategy-level comparison, only the same API (`/strategies`) and the
same USDC asset are used. That confirms that almost all DeFindex USDC strategy
TVL is in the Blend Fixed strategy. It does not mean every named DeFindex vault
is solely in that strategy; the vault API is required to map each vault's
allocation.

If a user deposits into a DeFindex vault whose allocation is wholly or
predominantly routed to the Fixed strategy contract, DeFindex is a wrapper
around the same underlying Blend pool Veil already uses. It adds dfTokens,
strategy/fee roles, and an extra contract layer; it does not create a separate
underlying source of yield.

## Implications

- Blend b/d positions are not tokens that can be transferred or posted as
  collateral elsewhere. They are address/accounting entries read through the
  pool.
- A pool receipt cannot be deposited into a second pool as a collateral asset
  or restaked without a protocol-specific wrapper.
- The same limitation applies to the backstop: backstop shares are contract
  accounting entries, not transferable b/d-style or SEP-41 receipts.
- DeFindex dfTokens can move, but moving a dfToken only moves ownership of the
  wrapped DeFindex position. It does not convert that position into a Blend
  bToken or remove the underlying contract and strategy risk.
- Gami earnUSDC shares are a separate Upshift share token and may be more
  composable as a token, but this has to be verified against the exact vault
  interface before collateral use.
- Soroswap LP shares and Aquarius AMM shares are AMM liquidity receipts, not
  lending receipts.
- Slender sTokens are supply receipts with a transfer interface; debt receipts
  are not transfer receipts.

The only downstream issue/numbering found in the repository was savings in
ADR 0005 and the existing vault contract. No repository reference to issue
#1277 or a restaking/savings issue set was found. That conclusion should be
linked to GitHub issue data if #1277 contains additional downstream work.

## Recommendation

**Recommend direct Blend Fixed V2 for Veil savings routing.**

Reasoning:

1. It is already the venue the Earn screen loads and the only venue with a
   repository integration and verified live mainnet contract instance.
2. It provides a direct supply position and instantaneous pool withdrawal,
   subject to pool liquidity and status.
3. DeFindex mostly adds a wrapper around the same Fixed strategy today; a
   wrapper should not replace direct Blend without a clear product reason
   such as multi-strategy diversification or a required transfer receipt.
4. Gami earnUSDC has curator-managed exposure and separate custody, liquidity,
   and administration risk. It should remain a separate, explicitly curated
   option rather than the default savings route.
5. AMM LP positions add impermanent loss and are not savings products.
   Slender and Templar need separate collateral/liquidation and receipt
   analysis before routing default savings.

Tradeoffs: direct Blend exposes users to Blend oracle, pool, utilization,
bad-debt and smart-contract risk, and bTokens cannot leave the address.
Gami or DeFindex can add token/transfer composability, but also add extra
contracts, fees and operational roles.

This recommendation changes if a verified direct-Blend rate becomes lower after
fees/risk adjustment; if pool liquidity or freeze conditions make redemption
unreliable; if Gami or DeFindex demonstrates materially different non-Blend
strategy diversification; or if a restaking/collateral integration has a
verified, transferable receipt and a clear liquidation model.

## Open questions / unverified items

- DeFindex mainnet factory contract ID.
- Exact per-vault DeFindex strategy allocation for each live vault.
- Aquarius AMM pool contract interface for an exact pool, especially
  `transfer`, `transfer_from`, and `approve`.
- Aquarius ICE receipt/lock contract and the exact lock/unlock/expiry
  mechanics.
- Templar lending pool, receipt, transfer, and exit contracts.
- A mainnet pair contract ID and transfer interface for a chosen Soroswap LP
  pair.
- Gami earnUSDC exact on-chain share transfer/approval interface and transfer
  restrictions.
- Any issue-ID mapping for downstream savings/restaking work. #1277 was not
  present in the repository files checked.
