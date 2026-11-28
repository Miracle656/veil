# Spending from a wallet allowance

How a Veil wallet lets another key spend a capped amount without the passkey,
what the wallet contract enforces, and the proof that it works on a real
network.

This is what the assistant's allowance is built on
(`frontend/wallet/lib/assistantAllowance.ts`).

## What an allowance is

The wallet contract has `approve(spender, token, amount, expiry)`. It needs the
passkey. After it:

- `spender` can move up to `amount` of `token` out of the wallet, with no
  passkey.
- The wallet counts every transfer down. Anything over what is left is refused.
- After `expiry` (plus 60 seconds of clock allowance) everything is refused.
- Nothing else is allowed through it: not another token, not any call that is
  not a token `transfer` out of the wallet, not another key.

The limit is held by the wallet contract. An app using the allowance cannot go
over it.

## How a spend is authorised

A simulation does not reveal this. It was found by experiment.

The call is the token's `transfer(from = wallet, to, amount)`, with two
authorisation entries:

1. **The wallet's entry.** Address credentials for the wallet. It is not
   signed: in place of a signature it carries the **spender's address**. That
   selects the allowance path in the wallet's `__check_auth`, which then calls
   `spender.require_auth()`. Its nonce and expiry ledger are simply chosen by
   whoever builds the transaction.
2. **The spender's entry.** Its root is the wallet's **`__check_auth` call
   itself**, with the arguments the network passes: the payload hash, the
   spender's address, and the list of calls being authorised
   (`Contract { args, contract, fn_name }`, keys in that order).
   - If the spender is the transaction's source account, this entry uses
     source-account credentials and needs no signature of its own.
   - If someone else pays the fee, it uses address credentials for the spender,
     signed in the ordinary account way.

The payload is the hash of the network, the wallet entry's nonce, its expiry
ledger and the exact transfer. The spender's approval covers that hash, so
nothing in the transfer can be changed afterwards.

The code is `buildAllowanceSpendAuth` in
`frontend/wallet/lib/allowanceSpend.ts`.

## Proof

Run on Stellar **testnet** on 27 November 2026, against a wallet created from
the exact contract code mainnet wallets run (wasm
`b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5`, read from
the mainnet factory and hash-checked). The testnet factory deploys an older
build, so the same sequence was also run on a factory wallet; every result was
the same.

Wallet `CAABK73F2367YXP53NQFYWCZQ2PW2NGTWZKXGDM2OYSGH32O5JAPC7BM`, token: testnet XLM
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`.

| Step | Result | Transaction |
|---|---|---|
| Passkey approves 5 XLM for one hour | Accepted | `4ad0346c7562c6baf515b1739a9dab24181ec003eca9650ef1e10f315b9acdce` |
| Spender sends 1 XLM, as transaction source | **Accepted.** Allowance 5 → 4 | `b3ffc15706969b38e677657dad17a4c8ba7ea63766ae94f33abd7b95ca021e07` |
| Spender sends 0.5 XLM, someone else paying the fee | **Accepted.** Allowance 4 → 3.5 | `e1123088723f29c5bbcc5cefa30e097ed8eaa8272244c95dad935679dc86521e` |
| Spender tries 10 XLM with 3.5 left | **Refused**, error 17 (over the allowance) | `05287e3833f33f4e40c6cf594301343b1342d08e3930d125172bdda8a3ccd02e` |
| Spender with no entry rooted at `__check_auth` | Refused | `553f11dbcc954e2934f8b737987a3b290f0b0686128f3e68b18e8d86e1e942cb` |
| A different token | Refused in simulation, error 17 | |
| The token's `approve`, or the wallet's `add_signer` | Refused in simulation, error 3 | |
| A different key using this allowance | Refused in simulation | |
| A 90-second allowance, used three minutes after it ended | **Refused**, error 18 (expired) | `a0d3562e91d985a351d6f833e6ffd3235bfd41ca7bc157f743d504d6838fb9e1` |
| Passkey replaces it with 1 unit, expiry in the past ("stop") | Accepted | `37744ca75530dbc5bb5b511f14d3e58e2f2a02b9bfd31cef20be0eb8bdeef796` |
| Spender tries again after the stop | Refused in simulation, error 18 | |

Also measured: an allowance spend does not change the wallet's own nonce, so it
cannot clash with a passkey transaction in progress.

To run it again: `scripts/spikes/allowance-spike.cjs`. It uses fresh throw-away
keys, testnet only, and takes about seven minutes because one step waits for an
allowance to expire.

## Limits of the deployed wallet

- **An allowance cannot be deleted.** `approve(amount = 0)` and
  `revoke_allowance` both fail on the deployed code. "Stop" is replacing it with
  the smallest amount and an expiry already past. The record stays on chain and
  must be shown as not usable.
- **The destination is not restricted.** The spender can send to any address,
  up to the cap. The cap and the end date are the protection.
- **An allowance with no expiry never ends.** The app always sets one.
- **The refusal reason is not in the error text.** A refused simulation says
  only `Error(Auth, InvalidAction)`. The wallet's own code (17, 18, 3) is in the
  diagnostic events; `contractErrorCode` reads it.

## Not proven

- A contract address as the spender.
- A spend routed through another contract that calls `transfer` for the wallet.
- More than one transfer in a single authorisation.
- The exact 60-second boundary after expiry.
- The refusals marked "in simulation" were shown by simulations that enforce
  authorisation, not by a failed transaction on chain.
- **The assistant's USDC allowance on mainnet has not been run yet.** The proof
  above used testnet XLM.
