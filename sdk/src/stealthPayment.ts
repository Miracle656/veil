import { StrKey, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import {
    bytesToHex,
    bytesToNumberBE,
    bytesToNumberLE,
    concatBytes,
    hexToBytes,
    numberToBytesBE,
    numberToBytesLE,
} from '@noble/curves/utils';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import type { TransactionSigner } from './signer';
import {
    createEscrow,
    type CreateEscrowOptions,
    type EscrowResult,
} from './claimableBalance';

const DOMAIN = new TextEncoder().encode('veil/stealth-payment/v2');
const SIGNING_DOMAIN = new TextEncoder().encode('veil/stealth-payment/v2/sign');
const ED25519_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const StellarXdr = xdr as unknown as {
    DecoratedSignature: new (attributes: {
        hint: Uint8Array;
        signature: Uint8Array;
    }) => Parameters<Transaction['addDecoratedSignature']>[0];
};

export type StealthIdentity = {
    /** X25519 and Ed25519 public keys, encoded as 128 hexadecimal characters. */
    publicKey: string;
    /** X25519 and Ed25519 secret keys, encoded as 128 hexadecimal characters. */
    secretKey: string;
};

export type DerivedStealthAddress = {
    address: string;
    /** Public ephemeral X25519 key that must be delivered to the receiver. */
    ephemeralPublicKey: string;
};

export type StealthAddressOptions = {
    recipientPublicKey: string;
    ephemeralPrivateKey?: Uint8Array;
    networkPassphrase: string;
};

export type RecoverStealthSignerOptions = {
    secretKey: string;
    ephemeralPublicKey: string;
    oneTimeAddress: string;
    balanceId: string;
    networkPassphrase: string;
};

export type StealthSigner = TransactionSigner & {
    address: string;
    balanceId: string;
};

export type SendStealthPaymentOptions = Omit<CreateEscrowOptions, 'recipientAddress'> & {
    recipientPublicKey: string;
};

export type StealthPaymentResult = EscrowResult & DerivedStealthAddress;

function decodeHex(value: string, name: string, bytes = 32): Uint8Array {
    if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(value)) {
        throw new Error(`${name} must be ${bytes} bytes encoded as ${bytes * 2} hexadecimal characters.`);
    }
    return hexToBytes(value);
}

function signWithScalar(message: Uint8Array, privateScalar: bigint, publicKey: Uint8Array): Uint8Array {
    const prefix = sha512(concatBytes(SIGNING_DOMAIN, numberToBytesBE(privateScalar, 32))).slice(0, 32);
    const nonce = bytesToNumberLE(sha512(concatBytes(prefix, message))) % ED25519_ORDER;
    const noncePublicKey = ed25519.Point.BASE.multiply(nonce).toBytes();
    const challenge = bytesToNumberLE(
        sha512(concatBytes(noncePublicKey, publicKey, message)),
    ) % ED25519_ORDER;
    const signatureScalar = (nonce + challenge * privateScalar) % ED25519_ORDER;
    return concatBytes(noncePublicKey, numberToBytesLE(signatureScalar, 32));
}

function oneTimeScalar(sharedSecret: Uint8Array, ephemeralPublicKey: Uint8Array, networkPassphrase: string): bigint {
    const network = new TextEncoder().encode(networkPassphrase);
    const scalar = bytesToNumberBE(sha256(concatBytes(DOMAIN, network, sharedSecret, ephemeralPublicKey))) % ED25519_ORDER;
    if (scalar === 0n) throw new Error('The derived one-time scalar is invalid.');
    return scalar;
}

function randomEd25519Secret(): Uint8Array {
    for (;;) {
        const secret = x25519.utils.randomSecretKey();
        if (bytesToNumberBE(secret) % ED25519_ORDER !== 0n) return secret;
    }
}

export function createStealthIdentity(): StealthIdentity {
    const x25519Secret = x25519.utils.randomSecretKey();
    const ed25519Secret = randomEd25519Secret();
    const ed25519PublicKey = ed25519.Point.BASE.multiply(
        bytesToNumberBE(ed25519Secret) % ED25519_ORDER,
    ).toBytes();
    return {
        publicKey: bytesToHex(concatBytes(x25519.getPublicKey(x25519Secret), ed25519PublicKey)),
        secretKey: bytesToHex(concatBytes(x25519Secret, ed25519Secret)),
    };
}

export function deriveStealthAddress(options: StealthAddressOptions): DerivedStealthAddress {
    const recipientPublicKey = decodeHex(options.recipientPublicKey, 'recipientPublicKey', 64);
    const recipientX25519PublicKey = recipientPublicKey.slice(0, 32);
    const recipientEd25519PublicKey = recipientPublicKey.slice(32);
    const ephemeralPrivateKey = options.ephemeralPrivateKey ?? x25519.utils.randomPrivateKey();
    if (ephemeralPrivateKey.length !== 32) {
        throw new Error('ephemeralPrivateKey must contain exactly 32 bytes.');
    }
    const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);
    let sharedSecret: Uint8Array;
    try {
        sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, recipientX25519PublicKey);
    } catch {
        throw new Error('recipientPublicKey is not a valid X25519 public key.');
    }
    if (sharedSecret.every((byte) => byte === 0)) {
        throw new Error('recipientPublicKey is not a valid X25519 public key.');
    }
    let recipientPoint;
    try {
        recipientPoint = ed25519.Point.fromHex(bytesToHex(recipientEd25519PublicKey));
    } catch {
        throw new Error('recipientPublicKey contains an invalid Ed25519 public key.');
    }
    if (recipientPoint.isSmallOrder() || !recipientPoint.isTorsionFree()) {
        throw new Error('recipientPublicKey contains an invalid Ed25519 public key.');
    }
    const scalar = oneTimeScalar(sharedSecret, ephemeralPublicKey, options.networkPassphrase);
    const publicKey = recipientPoint.multiply(scalar).toBytes();
    return {
        address: StrKey.encodeEd25519PublicKey(
            publicKey as unknown as Parameters<typeof StrKey.encodeEd25519PublicKey>[0],
        ),
        ephemeralPublicKey: bytesToHex(ephemeralPublicKey),
    };
}

export function recoverStealthSigner(options: RecoverStealthSignerOptions): StealthSigner {
    const networkPassphrase = options.networkPassphrase;
    const secretKey = decodeHex(options.secretKey, 'secretKey', 64);
    const x25519Secret = secretKey.slice(0, 32);
    const ed25519Secret = bytesToNumberBE(secretKey.slice(32)) % ED25519_ORDER;
    if (ed25519Secret === 0n) throw new Error('secretKey contains an invalid Ed25519 secret key.');
    const ephemeralPublicKey = decodeHex(options.ephemeralPublicKey, 'ephemeralPublicKey');
    let sharedSecret: Uint8Array;
    try {
        sharedSecret = x25519.getSharedSecret(x25519Secret, ephemeralPublicKey);
    } catch {
        throw new Error('ephemeralPublicKey is not a valid X25519 public key.');
    }
    if (sharedSecret.every((byte) => byte === 0)) {
        throw new Error('ephemeralPublicKey is not a valid X25519 public key.');
    }
    const scalar = oneTimeScalar(sharedSecret, ephemeralPublicKey, networkPassphrase);
    const privateScalar = scalar * ed25519Secret % ED25519_ORDER;
    const publicKey = ed25519.Point.BASE.multiply(privateScalar).toBytes();
    const address = StrKey.encodeEd25519PublicKey(
        publicKey as unknown as Parameters<typeof StrKey.encodeEd25519PublicKey>[0],
    );
    if (address !== options.oneTimeAddress) {
        throw new Error('The recovered one-time address does not match the claimable-balance claimant.');
    }
    const balanceId = options.balanceId.toLowerCase();
    if (!/^[0-9a-f]{72}$/.test(balanceId)) {
        throw new Error('balanceId must be a full claimable-balance ID encoded as 72 hexadecimal characters.');
    }

    return {
        publicKey: address,
        address,
        balanceId,
        signTransaction(xdr, context) {
            if (context.networkPassphrase !== networkPassphrase) {
                throw new Error('The one-time signer cannot sign for a different Stellar network.');
            }
            const transaction = TransactionBuilder.fromXDR(xdr, context.networkPassphrase);
            if (!(transaction instanceof Transaction)) {
                throw new Error('The one-time signer can only sign classic transactions.');
            }
            if (transaction.source !== address) {
                throw new Error('The one-time signer can only sign transactions from its own address.');
            }
            if (transaction.operations.length !== 1 || transaction.operations[0].type !== 'claimClaimableBalance') {
                throw new Error('The one-time signer can only sign a claimable-balance claim.');
            }
            const operation = transaction.operations[0];
            if (operation.source !== undefined && operation.source !== address) {
                throw new Error('The one-time signer can only claim from its own address.');
            }
            if (operation.balanceId.toLowerCase() !== balanceId) {
                throw new Error('The one-time signer can only claim its bound claimable balance.');
            }
            const signature = signWithScalar(
                Uint8Array.from(transaction.hash()),
                privateScalar,
                publicKey,
            );
            transaction.addDecoratedSignature(new StellarXdr.DecoratedSignature({
                hint: publicKey.slice(-4),
                signature,
            }));
            return transaction.toXDR();
        },
    };
}

export async function sendStealthPayment(options: SendStealthPaymentOptions): Promise<StealthPaymentResult> {
    const { recipientPublicKey, ...escrowOptions } = options;
    const derived = deriveStealthAddress({
        recipientPublicKey,
        networkPassphrase: options.config.networkPassphrase,
    });
    try {
        const escrow = await createEscrow({ ...escrowOptions, recipientAddress: derived.address });
        return { ...escrow, ...derived };
    } catch (error) {
        if (error instanceof Error && 'balanceId' in error && 'txHash' in error) {
            Object.assign(error, derived);
        }
        throw error;
    }
}
