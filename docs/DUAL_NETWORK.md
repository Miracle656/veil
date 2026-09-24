# Dual-network behaviour

Veil runs against two Stellar networks — testnet and mainnet — from one build.
The active network is a runtime choice stored in `localStorage` under
`veil_network`, not a build-time constant, so the same deployed site serves
both. `frontend/wallet/lib/network.ts` owns that resolution.

This document covers the part of that model where mistakes are expensive: values
that name something **on-chain**. It was written for issue
[#672](https://github.com/Miracle656/veil/issues/672).

## The rule

> A contract ID or WASM hash is only meaningful on the network it was deployed
> or installed on. Any such value must be resolved per network, and a network
> with no value must lose the feature — not silently borrow the other network's.

Endpoints and passphrases are the easy half; they are obviously per-network and
nobody hardcodes them. On-chain identifiers are the half that gets missed,
because a hash looks like a constant. It is not: it is a pointer into one
ledger.

The failure mode is specific and bad. `createCustomContract` with a hash the
network has never seen does not fail at page load, or at validation — it fails
at the *signature*, after the user has filled in a form. The user does the work,
then finds out.

## Where network-scoped values live

| Value | Resolver | Behaviour when unset |
| --- | --- | --- |
| RPC URL, passphrase, Horizon, friendbot | `lib/network.ts` → `NETWORKS` | Mainnet RPC unset ⇒ `isNetworkAvailable('mainnet')` is false, switcher disabled |
| Wallet factory contract ID | `lib/network.ts` → `NETWORKS[n].factoryContractId` | Both networks have verified committed defaults |
| Vault WASM hash | `lib/vault.ts` → `getVaultWasmHash()` | Throws at create; attaching to an existing vault still works |
| Multisig WASM hash | `lib/multisigConfig.ts` → `getMultisigDeployment()` | Route is gated off entirely on that network |
| USDC issuer | `lib/network.ts` → `getUsdcIssuer()` | n/a — both networks have a canonical issuer |
| Inclusion fee | `lib/fees.ts` → `inclusionFee()` | n/a |
| Wallet storage slots | `lib/network.ts` → `namespaceKey()` | n/a — mainnet keys carry a `_mainnet` suffix |

Two `NEXT_PUBLIC_*` variables per value, one per network, spelled out as literal
member expressions. Next.js inlines `NEXT_PUBLIC_*` into the client bundle by
matching the literal text in the source, so `process.env[someVariable]` is
**not** substituted and reads as `undefined` in the browser — it works in tests
and vanishes in production.

## Worked example: the multisig contract (#672)

`lib/multisig.ts` resolved its RPC URL and passphrase per network and then used
a single hardcoded WASM hash on both:

```ts
const MULTISIG_WASM_HASH = '7eb63568a7a41c19f5d85c55b5ec88c6f95ef840bcf98d1797850ace2dd3cf24';
```

### What is actually on-chain

Checked 2026-09-02 by querying the `CONTRACT_CODE` ledger entry for that hash
(procedure below):

| Network | `7eb63568…` | Evidence |
| --- | --- | --- |
| Testnet | **Installed** | 1 entry, `lastModifiedLedgerSeq` 2843166 |
| Mainnet | **Not installed** | 0 entries, on two independent RPC providers |

The control for that check: `b485f817…` (the wallet WASM) returns installed on
mainnet and not on testnet, which matches what `lib/network.ts` already records
about the mainnet factory. So the query is sound and the mainnet answer is a
real absence, not a broken request.

`scripts/upload_multisig_wasm.mjs` — the only tool that installs this contract —
hardcodes `https://soroban-testnet.stellar.org`, so testnet-only is the
expected state rather than a surprise.

### What the code does about it

- `lib/multisigConfig.ts` resolves the hash per network. Testnet keeps the
  verified hash as a committed default; mainnet has no default.
- `NEXT_PUBLIC_MULTISIG_WASM_HASH_TESTNET` / `_MAINNET` override per network.
- `/multisig` is **gated on reachability**, not merely unlinked:
  `app/multisig/MultisigGate.tsx` wraps the route in `app/multisig/layout.tsx`
  and never renders its children on a network without a hash, so the deploy
  wizard does not mount and redirects to `/dashboard`.
- Every entry point follows the same predicate, `isMultisigAvailable()`: the
  sidebar entry in `components/AppShell.tsx`, the dashboard chip, and the
  Settings card. The gate and the links cannot disagree.
- `getMultisigWasmHash()` throws — naming the network and the variable to set —
  and `deployAndInitMultisig` calls it *before* funding or signing anything.

### Enabling multisig on mainnet

1. Install the multisig WASM on mainnet (`scripts/upload_multisig_wasm.mjs`
   points at testnet; it needs a mainnet RPC and a funded, real-XLM fee payer).
2. Verify the resulting hash is on-chain with the procedure below.
3. Set `NEXT_PUBLIC_MULTISIG_WASM_HASH_MAINNET` to it and redeploy.

The route, the sidebar entry, the dashboard chip and the Settings card all
appear on mainnet from that one variable. Do not set it before step 1 — a hash
that is not on-chain restores exactly the failure this issue was about.

## Verifying that a WASM hash is installed

A hash is installed iff the network has a `CONTRACT_CODE` ledger entry for it.
Build the key and ask any Soroban RPC:

```js
import { xdr } from '@stellar/stellar-sdk'

const key = xdr.LedgerKey.contractCode(
  new xdr.LedgerKeyContractCode({ hash: Buffer.from(WASM_HASH, 'hex') }),
).toXDR('base64')

const res = await fetch(RPC_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys: [key] },
  }),
})
const { result } = await res.json()
// result.entries.length > 0  ⇒  installed on this network
```

`entries.length === 0` means not installed. Confirm `getNetwork().passphrase`
on the endpoint first, so a misrouted request cannot read as an absence, and
check a hash you know *is* on that network as a control.

Public endpoints used for the check above: `https://soroban-testnet.stellar.org`
for testnet; `https://mainnet.sorobanrpc.com` and
`https://soroban-rpc.mainnet.stellar.gateway.fm` for mainnet. The wallet's own
mainnet RPC is a keyed endpoint proxied through `app/api/rpc/mainnet` and is not
needed for this.

## Tests

`frontend/wallet/lib/__tests__/multisigConfig.test.ts` pins both networks in one
process by passing the network explicitly, the same technique
`walletStorage.test.ts` uses for per-network storage slots. It asserts that
testnet resolves a hash and mainnet does not, that neither network borrows the
other's, that a malformed value is reported as *invalid* rather than merged into
the deliberate mainnet gate, and that route availability and hash resolution can
never disagree.

Note the module-load hazard when writing such tests: `lib/network.ts` resolves
the active network **once**, at import. `setActiveNetwork` therefore does a full
`window.location.reload()`. Any test that needs a different active network must
seed `localStorage['veil_network']` and re-import under `jest.isolateModules`;
prefer designing the function to take the network as an argument instead.
