/**
 * Signing without handing the SDK a secret.
 *
 * A Stellar secret key in a browser or phone bundle is a leaked key. Every SDK
 * entry point that has to put a signature on a transaction therefore takes a
 * {@link TransactionSigner}: the SDK builds the transaction, hands over its XDR,
 * and the application signs wherever the key actually lives (typically a
 * backend) and returns the signed XDR.
 *
 * The SDK checks that what comes back is the transaction it sent, so a signer
 * cannot swap the operations for different ones.
 */

import { Keypair, TransactionBuilder, type FeeBumpTransaction, type Transaction } from '@stellar/stellar-sdk';

import { bufferToHex } from './utils';

/** Context handed to a signer alongside the XDR. */
export type SignTransactionContext = {
    /** Passphrase of the network the transaction is for. */
    networkPassphrase: string;
};

/**
 * Signs transactions on behalf of one Stellar account.
 *
 * `signTransaction` receives the base64 transaction envelope and must resolve to
 * the same envelope with this account's signature added. Throw (or reject) to
 * refuse: the SDK call fails with that error and nothing is submitted.
 */
export interface TransactionSigner {
    /** The `G…` address that signs, and that funds the transaction. */
    publicKey: string;
    signTransaction(
        xdr: string,
        context: SignTransactionContext,
    ): Promise<string> | string;
}

/**
 * What a signing parameter accepts.
 *
 * `Keypair` and `string` (a secret) are the original shapes and still work, but
 * are **deprecated**: passing one means a live secret is in the calling process,
 * and the SDK logs a one-time warning. Use a {@link TransactionSigner}.
 */
export type SignerInput =
    | TransactionSigner
    /** @deprecated Pass a {@link TransactionSigner}; a Keypair puts a secret in the client bundle. */
    | Keypair
    /** @deprecated Pass a {@link TransactionSigner}; a secret string puts a secret in the client bundle. */
    | string;

const warned = new Set<string>();

function warnLegacy(kind: 'secret string' | 'Keypair'): void {
    if (warned.has(kind)) return;
    warned.add(kind);
    // eslint-disable-next-line no-console
    console.warn(
        `[invisible-wallet-sdk] Passing a ${kind} as a signer is deprecated and will be removed in the next major ` +
        'version: it requires a live Stellar secret in your client bundle. Pass a TransactionSigner ' +
        '({ publicKey, signTransaction(xdr, { networkPassphrase }) }) that signs where the key lives.',
    );
}

/** Test hook: forget which deprecation warnings were already shown. */
export function _resetSignerDeprecationWarnings(): void {
    warned.clear();
}

/** A resolved signer: the callback shape, or a legacy in-process keypair. */
export type ResolvedSigner =
    | { kind: 'callback'; publicKey: string; signer: TransactionSigner }
    | { kind: 'legacy'; publicKey: string; keypair: Keypair };

function isCallbackSigner(input: SignerInput): input is TransactionSigner {
    return (
        typeof input === 'object' &&
        input !== null &&
        typeof (input as TransactionSigner).signTransaction === 'function' &&
        typeof (input as TransactionSigner).publicKey === 'string'
    );
}

/** Normalise any accepted signer input; warns once for the deprecated shapes. */
export function resolveSigner(input: SignerInput): ResolvedSigner {
    if (isCallbackSigner(input)) {
        return { kind: 'callback', publicKey: input.publicKey, signer: input };
    }
    if (typeof input === 'string') {
        warnLegacy('secret string');
        const keypair = Keypair.fromSecret(input);
        return { kind: 'legacy', publicKey: keypair.publicKey(), keypair };
    }
    warnLegacy('Keypair');
    const keypair = input as Keypair;
    return { kind: 'legacy', publicKey: keypair.publicKey(), keypair };
}

/**
 * Sign `tx` with `resolved` and return the signed transaction.
 *
 * Callback signers get the XDR and must return the same transaction (same hash)
 * with signatures added; anything else is rejected.
 */
export async function signWith<T extends Transaction | FeeBumpTransaction>(
    tx: T,
    resolved: ResolvedSigner,
    networkPassphrase: string,
): Promise<T> {
    if (resolved.kind === 'legacy') {
        tx.sign(resolved.keypair);
        return tx;
    }

    const signedXdr = await resolved.signer.signTransaction(tx.toXDR(), { networkPassphrase });
    if (typeof signedXdr !== 'string' || signedXdr.length === 0) {
        throw new Error('The signer did not return a signed transaction envelope.');
    }

    let signed: Transaction | FeeBumpTransaction;
    try {
        signed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    } catch {
        throw new Error('The signer returned something that is not a transaction envelope for this network.');
    }
    // stellar-sdk 17 hands back a Uint8Array, so the digests must be compared by
    // value — `!==` on two byte arrays only ever compares references.
    if (bufferToHex(signed.hash()) !== bufferToHex(tx.hash())) {
        throw new Error('The signer returned a different transaction than the one it was asked to sign.');
    }
    if (signed.signatures.length <= tx.signatures.length) {
        throw new Error('The signer returned the transaction without adding a signature.');
    }
    return signed as T;
}
