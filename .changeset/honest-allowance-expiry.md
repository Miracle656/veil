---
"invisible-wallet-sdk": patch
---

Fix `approve` with an expiry, which the wallet contract always rejected.

`approve` encoded `Some(expiry)` as a one-element `Vec[u64]`. The contract's
`expiry: Option<u64>` decodes `None` from `Void` and `Some` from the bare `u64`
(soroban-env-common `option.rs`), so the `Vec` failed conversion and every
`approve` that passed an expiry failed. The only allowances the SDK could grant
were permanent ones. It now sends the bare `u64`.

`approve` also accepts `bigint` for `amount` and `expiry`, so i128 amounts
are no longer rounded through a JS `number`. The argument encoding is exported
as `encodeApproveArgs`.

Note that `approve` replaces the stored expiry as well as the amount: calling
it without an expiry makes the allowance permanent, even if it had one before.
