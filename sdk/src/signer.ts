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
 * Only {@link TransactionSigner} is accepted. Secret-bearing inputs (`Keypair`
 * and secret strings) were deprecated and are removed in v1.0.0.
 */
export type SignerInput = TransactionSigner;

/**
 * Adapter that creates a {@link TransactionSigner} backed by an in-memory `Keypair`.
 *
 * Useful for backend services, test harnesses, or CLI scripts where the keypair
 * is already held in memory and signing can happen locally.
 */
export function createKeypairSigner(keypair: Keypair): TransactionSigner {
    return {
        publicKey: keypair.publicKey(),
        signTransaction(xdr: string, context: SignTransactionContext): string {
            const tx = TransactionBuilder.fromXDR(xdr, context.networkPassphrase);
            tx.sign(keypair);
            return tx.toXDR();
        },
    };
}

/** Test hook: retained for backwards-compatibility. */
export function _resetSignerDeprecationWarnings(): void {
    // Deprecation warnings are no longer emitted now that overloads are retired.
}

/** A resolved signer: the callback shape. */
export type ResolvedSigner = {
    kind: 'callback';
    publicKey: string;
    signer: TransactionSigner;
};

function isCallbackSigner(input: unknown): input is TransactionSigner {
    return (
        typeof input === 'object' &&
        input !== null &&
        typeof (input as TransactionSigner).signTransaction === 'function' &&
        typeof (input as TransactionSigner).publicKey === 'string'
    );
}

/** Normalise any accepted signer input. */
export function resolveSigner(input: SignerInput): ResolvedSigner {
    if (isCallbackSigner(input)) {
        return { kind: 'callback', publicKey: input.publicKey, signer: input };
    }
    throw new TypeError(
        'Expected a TransactionSigner ({ publicKey, signTransaction }). ' +
        'Secret strings and Keypairs are no longer supported as of v1.0.0; use createKeypairSigner(keypair) if holding a Keypair in a secure environment.',
    );
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
    if (signed.hash().toString('hex') !== tx.hash().toString('hex')) {
        throw new Error('The signer returned a different transaction than the one it was asked to sign.');
    }
    if (signed.signatures.length <= tx.signatures.length) {
        throw new Error('The signer returned the transaction without adding a signature.');
    }
    return signed as T;
}
