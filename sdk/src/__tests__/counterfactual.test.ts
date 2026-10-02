import { deriveCounterfactualAddress } from '../counterfactual';

// Valid Soroban contract strkey (C... 56 chars)
const MOCK_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

jest.mock('../utils', () => ({
    ...jest.requireActual('../utils'),
    computeWalletAddress: jest.fn(() => MOCK_ADDRESS),
}));

import { computeWalletAddress } from '../utils';
const mockComputeWalletAddress = computeWalletAddress as jest.MockedFunction<typeof computeWalletAddress>;

const CONFIG = {
    factoryAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    networkPassphrase: 'Test SDF Network ; September 2015',
};

const makePublicKey = (fill: number): Uint8Array => {
    const k = new Uint8Array(65);
    k[0] = 0x04;
    k.fill(fill, 1);
    return k;
};

describe('deriveCounterfactualAddress()', () => {
    beforeEach(() => {
        mockComputeWalletAddress.mockClear();
        mockComputeWalletAddress.mockReturnValue(MOCK_ADDRESS);
    });

    it('returns a deterministic address — same inputs produce same result', () => {
        const key = makePublicKey(0xab);
        const r1 = deriveCounterfactualAddress(key, CONFIG);
        const r2 = deriveCounterfactualAddress(key, CONFIG);
        expect(r1.address).toBe(r2.address);
    });

    it('different public keys → different addresses (mocked to return different values)', () => {
        const key1 = makePublicKey(0x01);
        const key2 = makePublicKey(0x02);

        mockComputeWalletAddress
            .mockReturnValueOnce('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
            .mockReturnValueOnce('CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');

        const r1 = deriveCounterfactualAddress(key1, CONFIG);
        const r2 = deriveCounterfactualAddress(key2, CONFIG);
        expect(r1.address).not.toBe(r2.address);
    });

    it('address starts with C and has length 56 (Soroban contract strkey)', () => {
        const result = deriveCounterfactualAddress(makePublicKey(0x04), CONFIG);
        expect(result.address).toMatch(/^C/);
        expect(result.address).toHaveLength(56);
    });

    it('returns publicKeyHex as hex encoding of the input key', () => {
        const key = makePublicKey(0x42);
        const result = deriveCounterfactualAddress(key, CONFIG);
        const expectedHex = Array.from(key)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        expect(result.publicKeyHex).toBe(expectedHex);
    });

    it('derivedAt is a recent timestamp', () => {
        const before = Date.now();
        const result = deriveCounterfactualAddress(makePublicKey(0x01), CONFIG);
        const after = Date.now();
        expect(result.derivedAt).toBeGreaterThanOrEqual(before);
        expect(result.derivedAt).toBeLessThanOrEqual(after);
    });

    it('calls computeWalletAddress with factoryAddress and networkPassphrase', () => {
        const key = makePublicKey(0x55);
        deriveCounterfactualAddress(key, CONFIG);
        expect(mockComputeWalletAddress).toHaveBeenCalledWith(
            CONFIG.factoryAddress,
            key,
            CONFIG.networkPassphrase
        );
    });
});
