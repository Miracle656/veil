import { StrKey, xdr, hash as stellarHash } from '@stellar/stellar-sdk';

// ── Wallet address derivation ─────────────────────────────────────────────────

/**
 * Compute the deterministic Soroban contract address for a user's passkey wallet
 * **without** deploying it.
 *
 * This mirrors the on-chain derivation exactly:
 *
 *   1. salt         = SHA-256(publicKeyBytes)          — factory hashes the 65-byte key to get 32 bytes
 *   2. networkId    = SHA-256(networkPassphrase)
 *   3. preimage     = XDR(ContractID { networkId, factory, salt })
 *   4. contractId   = SHA-256(preimage)
 *   5. address      = StrKey.encodeContract(contractId) → contract address
 *
 * @param factoryId        The factory contract's Stellar StrKey.
 * @param publicKeyBytes   The user's uncompressed P-256 public key (65 bytes: 0x04 ‖ x ‖ y).
 * @param networkPassphrase Stellar network passphrase. Defaults to testnet.
 * @returns The wallet's Stellar contract address in StrKey format.
 */
export function computeWalletAddress(
    factoryId: string,
    publicKeyBytes: Uint8Array,
    networkPassphrase = 'Test SDF Network ; September 2015'
): string {
    // Step 1: Hash the 65-byte public key → 32-byte salt.
    //   The factory contract calls env.crypto().sha256(&public_key_bytes) for the same reason:
    //   Soroban's deployer salt must be exactly 32 bytes (Uint256).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const salt = (stellarHash as any)(Buffer.from(publicKeyBytes)) as Buffer;

    // Step 2: Hash the network passphrase → 32-byte networkId.
    //   Every Stellar network has a unique passphrase, so contract IDs don't collide
    //   between testnet and mainnet even with identical inputs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const networkId = (stellarHash as any)(Buffer.from(networkPassphrase)) as Buffer;

    // Step 3: Decode the factory's strkey → raw 32-byte contract hash.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factoryHash = StrKey.decodeContract(factoryId) as any;

    // Step 4: Build the XDR preimage that Soroban hashes to derive contract addresses.
    //   This is the canonical HashIdPreimage::ContractId structure from the Stellar XDR spec.
    //   It encodes: "this contract was deployed by <factory> with <salt> on <network>".
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
        new xdr.HashIdPreimageContractId({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            networkId: networkId as any,
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                new xdr.ContractIdPreimageFromAddress({
                    address: xdr.ScAddress.scAddressTypeContract(factoryHash),
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    salt: salt as any,
                })
            ),
        })
    );

    // Step 5: SHA-256 the serialised XDR → 32-byte contract ID.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contractId = (stellarHash as any)(preimage.toXDR()) as Buffer;

    // Step 6: Encode as a Stellar contract StrKey.
    return StrKey.encodeContract(contractId);
}
