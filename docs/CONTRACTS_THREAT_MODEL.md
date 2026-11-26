# Wallet contracts threat model

This document describes the trust boundaries for the deployed Soroban wallet
contracts. It is based on the public interfaces under `contracts/`.

## Actors and capabilities

| Actor | Can do | Cannot do | Compromise cost |
| --- | --- | --- | --- |
| Passkey holder | Authorize wallet operations exposed by the wallet contracts | Bypass contract authorization or change deployed code | Funds controlled by that wallet can be transferred |
| Fee payer | Pay transaction fees and submit an already-authorized invocation | Spend wallet funds without wallet authorization | Fees and transaction metadata can be exposed |
| Factory admin | Use factory initialization and deployment paths | Upgrade an already deployed wallet instance | Can deploy or configure new instances under factory policy |
| Guardian | Use recovery methods guarded by the wallet contract | Act as the passkey holder for ordinary transfers | Recovery policy may be abused while compromised |
| dApp with an allowance | Spend the explicitly allowed amount | Exceed the allowance or call unrelated methods | The allowance amount and approved asset can be spent |
| RPC provider | Observe and delay transactions; provide simulation and status responses | Forge wallet authorization or alter chain state | Availability and privacy of submitted data |
| Indexer | Read and re-publish indexed public events | Authorize transactions or change contract state | Availability and freshness of displayed data |

## Accepted risks

Deployed contracts are immutable. There is no upgrade entry point for an
existing wallet; a fix requires a new deployment and existing wallets continue
running their current code. A compromised RPC or indexer can delay or
misrepresent data, so wallet decisions must rely on signed transaction results
and chain state. Passkey or guardian key loss is a user-held risk.

## Boundary tests

Authorization and allowance boundaries are covered by the Rust tests colocated
with each contract under `contracts/*/src/test.rs`. Run `cargo test` from
`contracts/` when changing an authorization boundary. Reproducible build
hashes in `contracts/expected-hashes.json` must be updated whenever contract
WASM changes.
