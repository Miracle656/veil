import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

/**
 * Encode the arguments of the wallet contract's
 * `approve(spender: Address, token: Address, amount: i128, expiry: Option<u64>)`.
 *
 * A Soroban `Option<T>` argument is `Void` for `None` and the bare `T` for
 * `Some` (soroban-env-common `option.rs`). It is **not** wrapped in a Vec: an
 * earlier version sent `Vec[u64]`, which fails conversion on the contract, so
 * every `approve` with an expiry was rejected and the only allowances that
 * could be granted were permanent ones.
 *
 * Note that `approve` replaces the stored expiry too: passing `undefined` here
 * makes the allowance permanent, even if it previously had an expiry.
 */
export function encodeApproveArgs(
    spender: string,
    token: string,
    amount: number | bigint,
    expiry?: number | bigint,
): xdr.ScVal[] {
    return [
        new Address(spender).toScVal(),
        new Address(token).toScVal(),
        nativeToScVal(BigInt(amount), { type: 'i128' }),
        expiry === undefined
            ? xdr.ScVal.scvVoid()
            : nativeToScVal(BigInt(expiry), { type: 'u64' }),
    ];
}
