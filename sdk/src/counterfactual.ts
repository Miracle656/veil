import { computeWalletAddress } from './utils';

export type CounterfactualConfig = {
    /** The factory contract's Stellar strkey (e.g. "CABC..."). */
    factoryAddress: string;
    /** Stellar network passphrase. Use Networks.TESTNET or Networks.PUBLIC. */
    networkPassphrase: string;
};

export type CounterfactualAddress = {
    /** Deterministic Soroban contract address (C... 56 chars). */
    address: string;
    /** Hex-encoded uncompressed P-256 public key used for derivation (130 hex chars). */
    publicKeyHex: string;
    /** Wall-clock timestamp (ms) when the address was derived. */
    derivedAt: number;
};

/**
 * Derive the deterministic wallet address for a given P-256 public key
 * before the wallet contract is deployed on-chain (counterfactual address).
 *
 * Uses the same 5-step algorithm as `computeWalletAddress` in utils.ts:
 *   1. Hash the public key bytes with SHA-256 to produce a 32-byte salt.
 *   2. Encode the factory address as a Soroban `ScAddress`.
 *   3. Construct a `HashIdPreimageContractId` XDR with the salt and factory.
 *   4. SHA-256 hash the XDR preimage.
 *   5. Encode the result as a Stellar contract strkey (`C...`).
 *
 * Third parties can independently verify this address by calling
 * `computeWalletAddress(factoryAddress, publicKeyBytes, networkPassphrase)`
 * with the same inputs — or by running the same XDR derivation against the
 * factory contract's source.
 *
 * @param publicKeyBytes Uncompressed P-256 public key (65 bytes, starting with 0x04).
 * @param config         Factory address + network passphrase.
 */
export function deriveCounterfactualAddress(
    publicKeyBytes: Uint8Array,
    config: CounterfactualConfig
): CounterfactualAddress {
    const address = computeWalletAddress(
        config.factoryAddress,
        publicKeyBytes,
        config.networkPassphrase
    );

    const hex = Array.from(publicKeyBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    return {
        address,
        publicKeyHex: hex,
        derivedAt: Date.now(),
    };
}
