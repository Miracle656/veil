# Session keys: what they can and cannot do

This page describes the session keys of the wallet code every Veil wallet on mainnet runs: WASM SHA-256 `b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5`, built from `contracts/invisible_wallet/src/` at commit `ccebd01a9b71c9857e6cd1e05dbdf6d45ea38ba2`. That contract cannot be upgraded. Everything below was observed on a real network, not read from the source.

## In plain words

A session key is a second key the owner adds with their passkey. The owner chooses **one token**, **one function** on it (`transfer`), **a total amount** and **an end time**.

A session key **can**:

- Send that token, through that function, until the total is used up or the end time passes.
- Send it **to anyone**. The contract never checks who receives the money. The owner does not name recipients, and cannot.

A session key **cannot**:

- Send more than the total, counted over its whole life. The total does not refill each day or week. Only registering the key again sets the amount used back to 0.
- Touch any other token.
- Call any other function on the same token, such as `approve`.
- Do anything after its end time (the contract allows 60 seconds of clock tolerance), or after the owner revokes it.
- Work without its own private key. Knowing the key id is not enough.
- Reuse an old signature.

**What to tell users:** "The assistant can spend up to X of this token until this date, to any address." Do not say or show that it can only pay certain people.

## Results

`sdk/tests/network/sessionKeyLimits.network.test.ts` checks each row as its own named test (`cd sdk && npm run test:network -- sessionKeyLimits`). The run below was on testnet on 2026-11-19. The wallet was deployed from the bytes mainnet runs, read from mainnet by hash, and the test checks the wallet's on-chain WASM hash before anything else. The session key was registered for `transfer` on the native XLM token with a cap of 1,000,000 stroops. The refusal reasons were read from the diagnostic events of the transaction on the ledger.

| Case | Expected | Observed |
|---|---|---|
| A transfer inside the cap | succeeds, `spent` goes up by the amount | succeeded, `spent` 0 → 300,000 |
| Several transfers adding up to more than the cap | the one that crosses it is refused | 300,000 and 400,000 succeeded. The next 400,000 was refused: `SessionKeyAclViolation` (#20). `spent` stayed at 700,000 |
| A transfer of a different token | refused | refused, `SessionKeyAclViolation` (#20) |
| `approve` on the same token contract | refused | refused, `SessionKeyAclViolation` (#20) |
| Any call after `expiry` | refused | refused, `SessionKeyExpired` (#19) |
| Any call after `revoke_session_key` | refused | refused, `SignerNotAuthorized` (#3) |
| The right `key_id` signed by a different ed25519 key | refused | refused, ed25519 verification failed (`Error(Crypto, InvalidInput)`) |
| A signature reused with an old nonce | refused | the same signed entry, resubmitted, was refused with `NonceMismatch` (#16). A fresh signature that carried the previous wallet nonce was refused the same way |
| A transfer inside the cap **to an address the owner never named** | **succeeds** | **succeeded** |
| Registering the same `key_id` again | `spent` is back to 0 | `spent` 800,001 → 0, then the full cap could be spent again |

## Transaction hashes

On testnet (network passphrase `Test SDF Network ; September 2015`). Testnet is reset from time to time, and after a reset these hashes will no longer be found. Rerun the test to get new ones.

- Wallet: `CCPVYZKUNMWUREDJMVF7DMGFPD22GDOKXMQPVJM2ZZSYTDEBMNSE3DEI`
- Session key's token, native XLM: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`
- **Accepted:** a transfer inside the cap, `63abac89537510fac3553337b87e02c7902d9299a590ff2ec478c75aee8a8e8f`
- **Refused:** the transfer that crossed the cap, `9930b05b335d58ed30d33ef3cb79e31f1a38743e442d6640ce68ca7a0a33de9b`
- **Accepted:** a transfer to an address the owner never named, `328874ba49e80ba832a9fdec228bf270e8bc15f4fe4eb929a05e4c8c3d3459d0`

## Things to know when building on this

- The wallet nonce is shared with the passkey. If the passkey and a session key sign at the same moment, one of them is refused with `NonceMismatch`. Nothing is spent. Read the nonce again and resubmit. The SDK reports this as `SessionKeyNonceMismatch`.
- The amount the contract counts is the **third argument** of the call. For `transfer(from, to, amount)` that is the amount.
- The longest end time the network can keep is about 180 days. A later one makes the whole registration fail. The SDK refuses it before anything is sent (see `sdk/README.md`).
- The SDK helpers are in `sdk/src/sessionKey.ts`.
