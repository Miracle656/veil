import {
    Account,
    BASE_FEE,
    Contract,
    Keypair,
    StrKey,
    TransactionBuilder,
    rpc as SorobanRpc,
} from '@stellar/stellar-sdk';
import { derToRawSignature, bufferToHex, hexToUint8Array } from '../utils';
import { isRegisteredSigner, type RegisteredSigner } from './signerRegistry';
import {
    InvalidWalletAddressError,
    NotVeilWalletError,
    PasskeyNotRegisteredError,
    WalletContractNotFoundError,
    WalletRecoveryNetworkError,
} from './signerErrors';
export { isRegisteredSigner } from './signerRegistry';
export type { RegisteredSigner } from './signerRegistry';
export {
    InvalidWalletAddressError,
    NotVeilWalletError,
    PasskeyNotRegisteredError,
    WalletContractNotFoundError,
    WalletRecoveryNetworkError,
} from './signerErrors';

export type WebAuthnAssertion = {
    authenticatorData: ArrayBuffer | Uint8Array;
    clientDataJSON: ArrayBuffer | Uint8Array;
    signature: ArrayBuffer | Uint8Array;
};

/** Verify one WebAuthn assertion against the wallet's on-chain signer set. */
export async function matchWebAuthnSigner(
    signers: RegisteredSigner[],
    assertion: WebAuthnAssertion,
): Promise<string | null> {
    const toBytes = (value: ArrayBuffer | Uint8Array) =>
        value instanceof Uint8Array ? value : new Uint8Array(value);
    const authData = toBytes(assertion.authenticatorData);
    const clientDataJSON = toBytes(assertion.clientDataJSON);
    const signature = toBytes(assertion.signature);
    const clientDataHash = new Uint8Array(
        await crypto.subtle.digest(
            'SHA-256',
            clientDataJSON.buffer.slice(
                clientDataJSON.byteOffset,
                clientDataJSON.byteOffset + clientDataJSON.byteLength,
            ) as ArrayBuffer,
        ),
    );
    const message = new Uint8Array(authData.length + clientDataHash.length);
    message.set(authData);
    message.set(clientDataHash, authData.length);
    const rawSignature = derToRawSignature(
        signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer,
    );

    for (const signer of signers) {
        const publicKey = signer instanceof Uint8Array ? signer : hexToUint8Array(signer);
        try {
            const cryptoKey = await crypto.subtle.importKey(
                'raw',
                publicKey.buffer.slice(publicKey.byteOffset, publicKey.byteOffset + publicKey.byteLength) as ArrayBuffer,
                { name: 'ECDSA', namedCurve: 'P-256' },
                false,
                ['verify'],
            );
            const valid = await crypto.subtle.verify(
                { name: 'ECDSA', hash: { name: 'SHA-256' } },
                cryptoKey,
                rawSignature.buffer as ArrayBuffer,
                message.buffer as ArrayBuffer,
            );
            if (valid) return bufferToHex(publicKey);
        } catch {
            // Ignore malformed or incompatible signer entries and try the next one.
        }
    }
    return null;
}

export type AddressRecoveryDependencies = {
    resolveSigners?: (address: string) => Promise<RegisteredSigner[]>;
    rpcUrl?: string;
    networkPassphrase?: string;
    authenticate: (signers: RegisteredSigner[]) => Promise<string | null>;
};

/** Simulate get_signers and parse its XDR map without relying on SDK hook state. */
export async function resolveWalletSigners(
    address: string,
    rpcUrl: string,
    networkPassphrase: string,
): Promise<Uint8Array[]> {
    const source = new Account(Keypair.random().publicKey(), '0');
    const transaction = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
        .addOperation(new Contract(address).call('get_signers'))
        .setTimeout(30)
        .build();
    const simulation = await new SorobanRpc.Server(rpcUrl).simulateTransaction(transaction);
    if (SorobanRpc.Api.isSimulationError(simulation)) {
        if (/not found|not_found|contract instance|missingvalue|missing value/i.test(simulation.error)) {
            throw new WalletContractNotFoundError(address);
        }
        if (/network|fetch|timeout|timed out|connection|\b429\b|\b5\d\d\b|gateway|temporarily unavailable/i.test(simulation.error)) {
            throw new WalletRecoveryNetworkError(address);
        }
        throw new NotVeilWalletError();
    }

    const retval = simulation.result?.retval;
    if (!retval) throw new NotVeilWalletError();
    try {
        return retval.map()?.map((entry) => new Uint8Array(entry.val().bytes())) ?? [];
    } catch {
        throw new NotVeilWalletError();
    }
}

/** Validate, resolve, and verify an address using one rule on every platform. */
export async function recoverWalletByAddress(
    input: string,
    dependencies: AddressRecoveryDependencies,
): Promise<{ address: string; signers: RegisteredSigner[]; publicKey: string }> {
    const address = input.trim();
    if (!StrKey.isValidContract(address)) throw new InvalidWalletAddressError();

    let signers: RegisteredSigner[];
    try {
        if (dependencies.resolveSigners) {
            signers = await dependencies.resolveSigners(address);
        } else if (dependencies.rpcUrl && dependencies.networkPassphrase) {
            signers = await resolveWalletSigners(address, dependencies.rpcUrl, dependencies.networkPassphrase);
        } else {
            throw new Error('Address recovery requires a signer resolver or network configuration.');
        }
    } catch (error) {
        if (
            error instanceof WalletContractNotFoundError ||
            error instanceof WalletRecoveryNetworkError ||
            error instanceof NotVeilWalletError
        ) throw error;
        throw new WalletRecoveryNetworkError(address, error);
    }
    if (signers.length === 0) throw new NotVeilWalletError();

    const publicKey = await dependencies.authenticate(signers);
    if (!publicKey || !isRegisteredSigner(signers, publicKey)) throw new PasskeyNotRegisteredError();
    return { address, signers, publicKey };
}
