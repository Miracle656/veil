---
"invisible-wallet-sdk": minor
---

Add session keys for the wallet code deployed on mainnet (WASM SHA-256
`b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5`).

- `buildRegisterSessionKeyCall` and `buildRevokeSessionKeyCall` build the
  wallet's own `register_session_key` and `revoke_session_key` calls, in the
  deployed argument order, for the passkey ceremony to sign. The register
  builder refuses an expiry later than `maxSessionKeyExpiry`: about 180 days on
  mainnet. Past that, the network refuses the whole registration.
- `signAuthEntryWithSessionKey` checks an auth entry against the transaction's
  own calls, then signs it with the session key and returns the three-item
  `[key_id, signature, wallet nonce]` credential.
- `readSessionKey` reads a key's record (`pubkey`, `targetContract`,
  `selector`, `amountCap`, `spent`, `expiry`) from temporary storage, or
  returns `null` when the wallet has none.
- `sessionKeyRetryableError` reports the wallet's `NonceMismatch`, which the
  host reports only as `Error(Auth, InvalidAction)`, as a retryable
  `SessionKeyNonceMismatch`.

`hostFunctionCalls` and `AuthEntryRejected` are now exported as well.
