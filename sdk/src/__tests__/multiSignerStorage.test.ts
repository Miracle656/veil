import {
    ADDITIONAL_SIGNERS_KEY,
    guardPrimaryBindingWrites,
    readAdditionalSignerCredentials,
    writeAdditionalSignerCredentials,
    type StorageAdapter,
} from '../walletStorage';
import { buildWebAuthnSignatureVector } from '../signatureVector';
import type { WebAuthnSignature } from '../core';

function memoryStorage(seed: Record<string, string> = {}) {
    const values = new Map(Object.entries(seed));
    const storage: StorageAdapter = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
            values.set(key, value);
        },
        removeItem: (key) => {
            values.delete(key);
        },
    };
    return { storage, values };
}

describe('additional signer storage', () => {
    it('stores an additional signer without changing the legacy primary binding', async () => {
        const primary = {
            invisible_wallet_key_id: 'primary-id',
            invisible_wallet_address: 'C-primary-wallet',
            invisible_wallet_public_key: '11'.repeat(65),
        };
        const { storage, values } = memoryStorage(primary);

        await writeAdditionalSignerCredentials(storage, [{
            credentialId: 'secondary-id',
            publicKey: '22'.repeat(65),
            status: 'active',
            signerIndex: 1,
        }]);

        for (const [key, value] of Object.entries(primary)) {
            expect(values.get(key)).toBe(value);
        }
        expect(values.has(ADDITIONAL_SIGNERS_KEY)).toBe(true);
        await expect(readAdditionalSignerCredentials(storage)).resolves.toEqual([
            expect.objectContaining({ credentialId: 'secondary-id', signerIndex: 1 }),
        ]);
    });

    it('migrates a legacy-only install to an empty versioned registry without changing primary keys', async () => {
        const primary = {
            invisible_wallet_key_id: 'existing-id',
            invisible_wallet_address: 'C-existing-wallet',
            invisible_wallet_public_key: 'ab'.repeat(65),
        };
        const { storage, values } = memoryStorage(primary);

        await expect(readAdditionalSignerCredentials(storage)).resolves.toEqual([]);
        expect(JSON.parse(values.get(ADDITIONAL_SIGNERS_KEY)!)).toEqual({
            version: 1,
            credentials: [],
        });
        for (const [key, value] of Object.entries(primary)) {
            expect(values.get(key)).toBe(value);
        }
    });

    it('throws when the add-signer operation attempts to write or remove a primary key', () => {
        const { storage } = memoryStorage();
        let guarded = true;
        const protectedStorage = guardPrimaryBindingWrites(storage, () => guarded);

        expect(() => protectedStorage.setItem('invisible_wallet_address', 'C-replacement'))
            .toThrow('Cannot write invisible_wallet_address during the add-signer flow.');
        expect(() => protectedStorage.removeItem?.('invisible_wallet_public_key'))
            .toThrow('Cannot remove invisible_wallet_public_key during the add-signer flow.');
        guarded = false;
        expect(() => protectedStorage.setItem('invisible_wallet_address', 'C-original')).not.toThrow();
    });
});

describe('WebAuthn signature vector', () => {
    it('encodes all five contract-required values, including the u64 nonce', () => {
        const signature: WebAuthnSignature = {
            publicKey: new Uint8Array(65).fill(1),
            authData: new Uint8Array([2, 3]),
            clientDataJSON: new Uint8Array([4, 5, 6]),
            signature: new Uint8Array(64).fill(7),
        };

        const vector = buildWebAuthnSignatureVector(signature, 42n).vec();
        expect(vector).toHaveLength(5);
        expect(vector?.[0].bytes()).toHaveLength(65);
        expect(vector?.[1].bytes()).toHaveLength(2);
        expect(vector?.[2].bytes()).toHaveLength(3);
        expect(vector?.[3].bytes()).toHaveLength(64);
        expect(vector?.[4].u64().toString()).toBe('42');
    });
});
