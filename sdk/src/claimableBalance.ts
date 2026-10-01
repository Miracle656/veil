import {
    Keypair,
    TransactionBuilder,
    BASE_FEE,
    Operation,
    Asset,
    Claimant,
    Horizon,
} from '@stellar/stellar-sdk';
import { resolveSigner, signWith, type SignerInput, type TransactionSigner } from './signer';

export type EscrowConfig = {
    /** Stellar Horizon REST API base URL (e.g. "https://horizon-testnet.stellar.org").
     *  Must be a Horizon URL — NOT a Soroban RPC endpoint. */
    horizonUrl: string;
    networkPassphrase: string;
};

export type CreateEscrowOptions = {
    /** Signs the escrow-creating transaction; the secret stays with the caller. */
    sender?: TransactionSigner;
    /** @deprecated Use `sender`. A Keypair puts a secret in the calling process. */
    senderKeypair?: Keypair;
    recipientAddress: string;
    amount: string;
    asset: Asset;
    /** Duration in seconds from now before the sender can reclaim the balance. */
    claimDeadlineSeconds: number;
    config: EscrowConfig;
};

export type EscrowResult = {
    balanceId: string;
    claimLink: string;
    expiresAt: number;
};

export type ClaimOptions = {
    /** Signs the claim transaction; the secret stays with the caller. */
    claimant?: TransactionSigner;
    /** @deprecated Use `claimant`. A Keypair puts a secret in the calling process. */
    claimantKeypair?: Keypair;
    balanceId: string;
    config: EscrowConfig;
};

export type ReclaimOptions = {
    /** Signs the reclaim transaction; the secret stays with the caller. */
    sender?: TransactionSigner;
    /** @deprecated Use `sender`. A Keypair puts a secret in the calling process. */
    senderKeypair?: Keypair;
    balanceId: string;
    config: EscrowConfig;
};

function pickSigner(callback: TransactionSigner | undefined, legacy: Keypair | undefined, name: string): SignerInput {
    const chosen = callback ?? legacy;
    if (!chosen) throw new Error(`A ${name} signer is required.`);
    return chosen;
}

export function buildClaimLink(balanceId: string): string {
    return `https://app.veil.xyz/claim/${balanceId}`;
}

/**
 * Build the two Stellar Claimant entries for an escrow balance:
 *  - recipient: may claim unconditionally at any time.
 *  - sender: may reclaim ONLY after `deadlineUnix` (unix timestamp).
 *
 * A Stellar claimable balance is consumed by the first successful claim.
 * Once either party claims, the balance is gone — the other party's subsequent
 * claim will be rejected by the Stellar network. Design UIs accordingly.
 */
export function buildEscrowClaimants(
    recipientAddress: string,
    senderAddress: string,
    deadlineUnix: number
): Claimant[] {
    const recipientClaimant = new Claimant(recipientAddress, Claimant.predicateUnconditional());
    const senderClaimant = new Claimant(
        senderAddress,
        Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(deadlineUnix.toString()))
    );
    return [recipientClaimant, senderClaimant];
}

/**
 * Create a Stellar claimable balance escrow.
 *
 * The recipient may claim immediately (unconditional predicate).
 * The sender may reclaim after `claimDeadlineSeconds` has elapsed.
 * Claim and reclaim are mutually exclusive — the first successful claim
 * consumes the balance.
 *
 * @throws If Horizon does not return a balance_id in its response.
 */
export async function createEscrow(options: CreateEscrowOptions): Promise<EscrowResult> {
    const { recipientAddress, amount, asset, claimDeadlineSeconds, config } = options;
    const signer = resolveSigner(pickSigner(options.sender, options.senderKeypair, 'sender'));
    const server = new Horizon.Server(config.horizonUrl);

    const account = await server.loadAccount(signer.publicKey);
    const expiresAt = Math.floor(Date.now() / 1000) + claimDeadlineSeconds;

    const claimants = buildEscrowClaimants(recipientAddress, signer.publicKey, expiresAt);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
    })
        .addOperation(
            Operation.createClaimableBalance({
                asset,
                amount,
                claimants,
            })
        )
        .setTimeout(180)
        .build();

    const signedTx = await signWith(tx, signer, config.networkPassphrase);

    const result = await server.submitTransaction(signedTx);
    const balanceId = (result as unknown as { balance_id?: string }).balance_id;
    if (!balanceId) {
        throw new Error('create_claimable_balance: missing balance_id in Horizon response');
    }

    return {
        balanceId,
        claimLink: buildClaimLink(balanceId),
        expiresAt,
    };
}

/**
 * Claim a claimable balance as the recipient.
 *
 * Once claimed the balance is consumed. A subsequent reclaimEscrow() call
 * by the sender will be rejected by the Stellar network.
 */
export async function claimEscrow(options: ClaimOptions): Promise<{ txHash: string }> {
    const { balanceId, config } = options;
    const signer = resolveSigner(pickSigner(options.claimant, options.claimantKeypair, 'claimant'));
    const server = new Horizon.Server(config.horizonUrl);

    const account = await server.loadAccount(signer.publicKey);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
    })
        .addOperation(Operation.claimClaimableBalance({ balanceId }))
        .setTimeout(180)
        .build();

    const signedTx = await signWith(tx, signer, config.networkPassphrase);

    const result = await server.submitTransaction(signedTx);
    return { txHash: result.hash };
}

/**
 * Reclaim a claimable balance as the sender after the deadline has passed.
 *
 * Will be rejected by the Stellar network if called before `expiresAt` or
 * if the recipient has already claimed the balance.
 */
export async function reclaimEscrow(options: ReclaimOptions): Promise<{ txHash: string }> {
    const { balanceId, config } = options;
    const signer = resolveSigner(pickSigner(options.sender, options.senderKeypair, 'sender'));
    const server = new Horizon.Server(config.horizonUrl);

    const account = await server.loadAccount(signer.publicKey);

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
    })
        .addOperation(Operation.claimClaimableBalance({ balanceId }))
        .setTimeout(180)
        .build();

    const signedTx = await signWith(tx, signer, config.networkPassphrase);

    const result = await server.submitTransaction(signedTx);
    return { txHash: result.hash };
}
