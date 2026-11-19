---
"invisible-wallet-sdk": patch
---

`signSorobanAuthEntry` can no longer produce a four-element signature vector.

The wallet contract's `__check_auth` accepts exactly five elements — the
nonce is the fifth — and rejects anything else with `InvalidSignatureFormat`
(#2). The helper used to append the nonce only when the caller supplied
`getNonce`, and to skip it when `getNonce` returned `null`, so a caller could
build a signature the contract was certain to refuse, after the user had
already approved it with their passkey.

`getNonce` is now a required option. A nonce it cannot produce is an error,
raised before the passkey is prompted, instead of a shorter vector. The SEP-43
adapter likewise reports a client error when it can sign auth entries but has no
`getWalletNonce`. Callers that already pass `getNonce` are unaffected.

The SDK is also now tested against the real contract: an end-to-end test signs
with `signSorobanAuthEntry` for a deployed wallet on a local network and
requires `__check_auth` to accept it (`npm run test:e2e:local`).
