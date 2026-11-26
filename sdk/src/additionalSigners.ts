/**
 * Additional signer credentials — passkeys that can authorise this wallet but
 * are not the one it is bound to.
 *
 * A device's PRIMARY binding is the wallet address, the credential id and the
 * public key that `register()` (or a sign-in) wrote. Everything else on the
 * device is derived from those three: the fee payer comes from the primary
 * credential's PRF, the address from its public key, every signature from its
 * id. Overwriting any of them repoints the device at a different wallet, which
 * is how the first "Add a passkey" button would have stranded funds.
 *
 * So an additional signer lives under its own key, in its own versioned record,
 * and the code that writes it goes through {@link guardPrimaryBinding}: a
 * storage view that throws on any write to a primary key. Adding a device can
 * then fail, but it cannot replace the wallet it is being added to.
 */

import type { StorageAdapter } from './core';

/** Storage key for the additional-signer registry (network-namespaced like every wallet key). */
export const ADDITIONAL_SIGNERS_KEY = 'invisible_wallet_additional_signers';

/**
 * The keys that make up a device's primary wallet binding. Nothing on the
 * add-a-signer path may write or remove any of them.
 */
export const PRIMARY_BINDING_KEYS: readonly string[] = [
    'invisible_wallet_address',
    'invisible_wallet_key_id',
    'invisible_wallet_public_key',
    'invisible_wallet_user_id',
    'invisible_wallet_portable_signer',
    'veil_signer_secret',
    'veil_signer_public_key',
];

const PRIMARY_KEY_SET = new Set(PRIMARY_BINDING_KEYS);

/** True when `key` (bare, or with a network suffix such as `_mainnet`) is a primary-binding key. */
export function isPrimaryBindingKey(key: string): boolean {
    if (PRIMARY_KEY_SET.has(key)) return true;
    for (const primary of PRIMARY_BINDING_KEYS) {
        if (key.startsWith(`${primary}_`)) return true;
    }
    return false;
}

export class PrimaryBindingWriteError extends Error {
    readonly key: string;

    constructor(key: string) {
        super(
            `Refusing to modify "${key}": it belongs to this device's primary wallet binding, ` +
                'and adding a signer must never change which wallet the device controls.',
        );
        this.name = 'PrimaryBindingWriteError';
        this.key = key;
    }
}

/**
 * A storage view that reads everything but refuses to write or remove any
 * {@link PRIMARY_BINDING_KEYS}. The add-signer path is handed this view rather
 * than the raw store, so a mistake there throws instead of rebinding the wallet.
 */
export function guardPrimaryBinding(storage: StorageAdapter): StorageAdapter {
    return {
        getItem: (key) => storage.getItem(key),
        setItem: (key, value) => {
            if (isPrimaryBindingKey(key)) throw new PrimaryBindingWriteError(key);
            return storage.setItem(key, value);
        },
        removeItem: (key) => {
            if (isPrimaryBindingKey(key)) throw new PrimaryBindingWriteError(key);
            return storage.removeItem?.(key);
        },
    };
}

export type AdditionalSignerStatus =
    /**
     * Created and saved, but not yet confirmed in the wallet's on-chain signer
     * list. Either the add_signer transaction has not landed, or its outcome is
     * unknown — the on-chain list decides which.
     */
    | 'pending'
    /** Confirmed in the wallet contract's `get_signers`. */
    | 'active';

export type AdditionalSigner = {
    /** Base64url WebAuthn credential id. */
    credentialId: string;
    /** Uncompressed P-256 public key, lowercase hex (130 chars, starts `04`). */
    publicKey: string;
    status: AdditionalSignerStatus;
    /** Slot in the contract's signer map, once confirmed. */
    signerIndex?: number;
    /** Transport hints for a roaming key, replayed when asking it to sign. */
    transports?: string[];
    /** ISO-8601 time the credential was created. */
    addedAt: string;
};

type AdditionalSignerRecord = {
    version: 1;
    signers: AdditionalSigner[];
};

export class AdditionalSignerStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AdditionalSignerStoreError';
    }
}

const PUBLIC_KEY_RE = /^04[0-9a-f]{128}$/;

function isValidSigner(value: unknown): value is AdditionalSigner {
    if (typeof value !== 'object' || value === null) return false;
    const s = value as Record<string, unknown>;
    if (typeof s.credentialId !== 'string' || s.credentialId.length === 0) return false;
    if (typeof s.publicKey !== 'string' || !PUBLIC_KEY_RE.test(s.publicKey)) return false;
    if (s.status !== 'pending' && s.status !== 'active') return false;
    if (s.signerIndex !== undefined && (!Number.isInteger(s.signerIndex) || (s.signerIndex as number) < 0)) {
        return false;
    }
    if (s.transports !== undefined && (!Array.isArray(s.transports) || !s.transports.every((t) => typeof t === 'string'))) {
        return false;
    }
    return typeof s.addedAt === 'string';
}

/**
 * Parse a stored registry. Malformed data throws rather than reading as empty:
 * an empty list would let the next write silently drop credentials that may
 * already be signers on chain.
 */
export function parseAdditionalSigners(raw: string): AdditionalSigner[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new AdditionalSignerStoreError('The saved list of additional passkeys is unreadable.');
    }
    const record = parsed as Partial<AdditionalSignerRecord> | null;
    if (!record || record.version !== 1 || !Array.isArray(record.signers)) {
        throw new AdditionalSignerStoreError('The saved list of additional passkeys has an unknown format.');
    }
    if (!record.signers.every(isValidSigner)) {
        throw new AdditionalSignerStoreError('The saved list of additional passkeys contains an invalid entry.');
    }
    return record.signers;
}

export function serializeAdditionalSigners(signers: AdditionalSigner[]): string {
    const record: AdditionalSignerRecord = { version: 1, signers };
    return JSON.stringify(record);
}

/** The additional signers saved on this device; `[]` when none have been added. */
export async function readAdditionalSigners(storage: StorageAdapter): Promise<AdditionalSigner[]> {
    const raw = await storage.getItem(ADDITIONAL_SIGNERS_KEY);
    return raw === null || raw === undefined ? [] : parseAdditionalSigners(raw);
}

async function writeAdditionalSigners(storage: StorageAdapter, signers: AdditionalSigner[]): Promise<void> {
    // Written through the guard even though the key is not a primary one, so a
    // future edit that points this at the wrong key fails loudly.
    await guardPrimaryBinding(storage).setItem(ADDITIONAL_SIGNERS_KEY, serializeAdditionalSigners(signers));
}

/**
 * Insert or update one additional signer, matched by credential id.
 *
 * Refuses a credential that IS the primary one (same id or same key): that is
 * not a second device, and recording it as one is the confusion this module
 * exists to prevent.
 */
export async function saveAdditionalSigner(
    storage: StorageAdapter,
    signer: AdditionalSigner,
    primary: { credentialId: string | null; publicKey: string | null },
): Promise<void> {
    if (!isValidSigner(signer)) {
        throw new AdditionalSignerStoreError('Refusing to save an invalid additional passkey.');
    }
    if (primary.credentialId && signer.credentialId === primary.credentialId) {
        throw new AdditionalSignerStoreError('This passkey is the wallet’s primary passkey, not an additional one.');
    }
    if (primary.publicKey && signer.publicKey === primary.publicKey.toLowerCase()) {
        throw new AdditionalSignerStoreError('This passkey is the wallet’s primary passkey, not an additional one.');
    }

    const existing = await readAdditionalSigners(storage);
    const clash = existing.find((s) => s.publicKey === signer.publicKey && s.credentialId !== signer.credentialId);
    if (clash) {
        throw new AdditionalSignerStoreError('Another saved passkey already has this public key.');
    }
    const next = existing.some((s) => s.credentialId === signer.credentialId)
        ? existing.map((s) => (s.credentialId === signer.credentialId ? signer : s))
        : [...existing, signer];
    await writeAdditionalSigners(storage, next);
}

/** Forget one additional signer on this device. Does not touch the chain. */
export async function forgetAdditionalSigner(storage: StorageAdapter, credentialId: string): Promise<void> {
    const existing = await readAdditionalSigners(storage);
    const next = existing.filter((s) => s.credentialId !== credentialId);
    if (next.length !== existing.length) await writeAdditionalSigners(storage, next);
}
