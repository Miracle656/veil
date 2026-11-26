# SEP-45 spike — Web Authentication for Contract Accounts

**Status:** phase 1 complete (challenge fetched, decoded and verified against a live anchor).
Phase 2 client code (`frontend/wallet/lib/sep45.ts`) has landed — see
["Phase 2 — what shipped"](#phase-2--what-shipped) below for exactly what is
and is not verified.
**Date:** 2026-08-24 (phase 1); updated 2026-09-27 (phase 2 code).

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

## Phase 2 — what shipped

`frontend/wallet/lib/sep45.ts` implements the full client side of the flow:

- `fetchSep45Challenge` — GETs the anchor's `WEB_AUTH_FOR_CONTRACTS_ENDPOINT` and parses
  the response, accepting both `authorization_entries`/`network_passphrase` (spec) and
  `authorizationEntries`/`networkPassphrase` (the SDF test anchor's actual field names).
- `signSep45Challenge` — finds the entry whose signature is still `scvVoid` (the wallet's,
  regardless of its position in the array), then validates it before signing anything:
  the challenge's network passphrase must match the wallet's configured network
  (`WRONG_NETWORK`), the unsigned entry must be addressed to the caller's own wallet
  address, and its invocation must be a `web_auth_verify` call on the anchor's declared
  web-auth contract with no sub-invocations and `account` / `home_domain` arguments
  matching the wallet and requested domain (`INVALID_CHALLENGE` otherwise). `__check_auth`
  verifies the WebAuthn signature over the preimage hash and nothing about what is being
  authorized, so this module has to check first — an anchor (or an MITM of the
  `stellar.toml` fetch) could otherwise hand back a "challenge" invoking a token
  `transfer` instead. Once validated, this builds the same
  `HashIdPreimageSorobanAuthorization` the SDK's own `authorizeEntries` builds for a normal
  contract call, hands the hash to the existing passkey `signAuthEntry` signer, and sets a
  deliberate `sigExpLedger` (see `SEP45_SIGNATURE_EXPIRATION_LEDGERS` for the reasoning).
  The anchor's own already-signed entry is passed through untouched.
- `submitSep45Challenge` — POSTs both entries back and returns the JWT, mapping the
  anchor's failure modes to a typed `Sep45Error` (`CHALLENGE_EXPIRED`,
  `SIGNATURE_REJECTED`, `ANCHOR_ERROR`, `NETWORK_ERROR`, `INVALID_RESPONSE`,
  `INVALID_CHALLENGE`, `WRONG_NETWORK`).
- The returned JWT is a normal bearer token — `lib/__tests__/sep45.test.ts` has an
  end-to-end (mocked) test showing it flow straight into `initiateDeposit` from
  `lib/sep24.ts`, in place of the fee-payer's SEP-10 token.

The gotchas below were the reason phase 1 took as long as it did; phase 2 hit one more
worth recording: **the top-level `@stellar/js-xdr` install and the copy `@stellar/stellar-sdk`
depends on internally can be two different major versions** (3.x vs 4.x seen during this
work), and their `XdrReader`/`XdrWriter` are not interchangeable — decoding with one
version's reader against a `VarArray` built from the other's generated type throws deep
inside js-xdr with an unhelpful error. Fix: pin `@stellar/js-xdr` in `package.json` to the
same range `@stellar/stellar-sdk`'s own `stellar-base` dependency declares, so npm dedupes
to one copy. Also: despite `__esModule: true`, the package has no `default` export, so
`import jsXdr from '@stellar/js-xdr'` resolves to `undefined` under `esModuleInterop` — use
`import * as jsXdr from '@stellar/js-xdr'` instead.

### What is **not** verified here

The acceptance criteria for the issue this phase closes ask for the anchor's actual
response to a signed challenge, pasted into the PR. That step is a real WebAuthn
ceremony — a physical authenticator, a browser, user presence — against a live testnet
wallet. It cannot run in a headless CI sandbox, and this change was authored in one, so:

- **No live SDF-test-anchor JWT transcript accompanies this change.** Every test above
  exercises the client logic with an injected passkey signer and a mocked anchor; the
  code path is real, the network calls in the tests are not.
- A maintainer (or CI with real browser + authenticator access) should run this once
  against a funded testnet wallet and paste the anchor's `{"token": "..."}` response
  (redacted) into a follow-up, per the acceptance criteria. Everything downstream of that
  call — parsing, signing, submitting, and using the JWT for a SEP-24 call — is exercised
  and passing in this PR; only the live ceremony itself is outstanding.

## Probe

`frontend/wallet/__sep45probe.mjs` (gitignored). Run with `node __sep45probe.mjs` from
`frontend/wallet`.
