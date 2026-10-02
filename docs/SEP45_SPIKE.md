# SEP-45 spike — Web Authentication for Contract Accounts

**Status:** phase 1 complete (challenge fetched, decoded and verified against a live anchor).
**Date:** 2026-08-24.

## Why this matters to Veil

SEP-10, the authentication every Stellar anchor uses today, only accepts `G…` and `M…`
addresses. A Veil wallet **is** a `C…` contract account, so it cannot authenticate to an
anchor at all under SEP-10 — the deposit and withdrawal flows have to borrow the
fee-payer's `G…` identity, which is not the account holding the funds.

SEP-45 is the fix: the same web-auth handshake, but for contract accounts.

## It is live, not theoretical

Two production anchors already publish a SEP-45 endpoint, both pointing at the same
contract:

| Anchor | `WEB_AUTH_FOR_CONTRACTS_ENDPOINT` | `WEB_AUTH_CONTRACT_ID` |
|---|---|---|
| SDF test anchor | `https://testanchor.stellar.org/sep45/auth` | `CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX` |
| MoneyGram (production) | undocumented, present in their toml | same contract id |

MoneyGram's is absent from their own documentation, which is worth knowing before
building against it.

## What a real challenge looks like

`GET /sep45/auth?account=C…&home_domain=testanchor.stellar.org` returns **200** with an
XDR array of two `SorobanAuthorizationEntry` values. Decoded:

```
entry 0  credentials : sorobanCredentialsAddress
         signer      : C…            <- the wallet; signature is scvVoid (unsigned)
         sigExpLedger: 0
entry 1  credentials : sorobanCredentialsAddress
         signer      : G… SIGNING_KEY <- the anchor; signature is scvVec (already signed)
         sigExpLedger: 4314260

both     contract    : CD3LA6RK…  (matches the toml)
         function    : web_auth_verify
         args        : account, home_domain, nonce, web_auth_domain,
                       web_auth_domain_account
         subInvocations: 0
```

The client's job is to verify entry 1 (the anchor really signed it, args are what we
asked for, no sub-invocations), sign entry 0, and POST both back. The anchor simulates
and returns `{"token": "<JWT>"}`.

## The important finding

**Entry 0 is exactly the object our passkey path already signs.** A
`SorobanAuthorizationEntry` with address credentials, a nonce and a signature-expiration
ledger is the same primitive `__check_auth` consumes for every ordinary contract call.
SEP-45 needs no new cryptography, no new contract, and no change to the wallet contract —
only a new caller for the existing signer.

That makes SEP-45 a genuinely small piece of work for Veil, and a differentiator: a
passkey smart wallet that can authenticate to anchors *as itself*.

## Gotchas found by probing rather than reading

1. **The field name does not match the spec.** SEP-45 specifies
   `authorization_entries` / `network_passphrase`; the SDF test anchor returns
   **`authorizationEntries`** (camelCase). A client that reads only the spec name gets
   `undefined` and a 200. Accept both.
2. **There is no generated XDR type for the array.** The payload is a variable-length
   array of `SorobanAuthorizationEntry`, and `SorobanAuthorizationEntry.fromXDR()` will
   not parse it. Compose the type:
   ```js
   import jsXdr from '@stellar/js-xdr'
   new jsXdr.VarArray(xdr.SorobanAuthorizationEntry).fromXDR(buf)
   ```
3. **`@stellar/js-xdr` is CommonJS.** `import { VarArray } from '@stellar/js-xdr'` fails
   under ESM; import the default and destructure.
4. **The unsigned entry carries `sigExpLedger: 0`.** The client sets the real expiration
   when it signs, exactly as it does for a normal contract invocation.

## Phase 2 — what is left

Signing requires a **testnet Veil wallet with a real passkey**, since the assertion is an
interactive browser ceremony. The probe used the deployed testnet factory address as a
stand-in to inspect the challenge; it cannot sign for it.

Remaining work:

1. Deploy a testnet wallet and register a passkey against it.
2. Sign entry 0 with the existing passkey signer, setting a sensible expiration ledger.
3. Re-encode both entries and POST them back.
4. Store the returned JWT and use it for SEP-6 / SEP-24 calls in place of the SEP-10
   token the fee-payer currently obtains.

Blocked on nothing but a testnet wallet — which is itself blocked on
[#628](https://github.com/Miracle656/veil/issues/628), since switching the web wallet to
testnet today can overwrite mainnet state.

## Probe

`frontend/wallet/__sep45probe.mjs` (gitignored). Run with `node __sep45probe.mjs` from
`frontend/wallet`.
