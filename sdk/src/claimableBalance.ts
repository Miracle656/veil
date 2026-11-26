import {
    Keypair,
    TransactionBuilder,
    BASE_FEE,
    Operation,
    Asset,
    Claimant,
    Horizon,
} from '@stellar/stellar-sdk';
import {
    resolveSigner,
    signWith,
    type ResolvedSigner,
    type SignerInput,
    type TransactionSigner,
} from './signer';

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

export type FeeBumpedClaimOptions = {
    /**
     * The one-time key that is a claimant on the balance. It signs the claim and
     * pays nothing: a fee bump covers the fee, so it needs no XLM of its own.
     */
    claimant: TransactionSigner;
    /**
     * The account that pays the fee for this claim (CAP-15 fee bump).
     *
     * PRIVACY — this choice is visible, and it is the link: the fee-bump's fee
     * source is written into the transaction's ledger entry, permanently and
     * publicly, next to the claim it paid for. Paying from an account tied to
     * the user (a wallet's own fee payer, an exchange account) ties this
     * one-time address and the balance it just claimed to that user — the same
     * link a direct claim from their wallet would have created. It only looks
     * private to someone who does not read the fee source.
     *
     * What the user can do about it: pay from a fee payer that is not tied to
     * them — a fresh account funded from somewhere the network cannot connect
     * to them (a withdrawal from an exchange, a transfer from a friend) and
     * used once — and then the claim is not attributable through the fee. Or
     * reuse the wallet's fee payer and accept that the claim is public. Both
     * are honest choices; presenting a claim paid by the wallet's fee payer as
     * private is not.
     *
     * The same applies to the account creation below: when the one-time address
     * has never been funded, this account pays to create it, and that
     * `create_account` is public too.
     */
    feePayer: TransactionSigner;
    /** The claimable balance id, `00000000…`. */
    balanceId: string;
    config: EscrowConfig;
    /** Fee bid per operation, in stroops. Defaults to the network minimum (`BASE_FEE`). */
    baseFee?: string;
    /**
     * XLM the fee payer puts into a one-time account that has never been funded,
     * so the claim has a source account to sign from. Defaults to `"1"` — the
     * 2 × base reserve an account needs to exist. Ignored when the account is
     * already on the ledger.
     */
    claimantStartingBalance?: string;
};

export type FeeBumpedClaimResult = {
    /** Hash of the fee-bump transaction that carried the claim. */
    txHash: string;
    /** True when the claimant account did not exist and the fee payer created it first. */
    claimantAccountCreated: boolean;
    /** The account the ledger records as having paid for this claim. */
    feePayer: string;
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
 * Claim a claimable balance from an account that cannot pay its own fee.
 *
 * A one-time address can be a claimant while holding no XLM at all, so the
 * ordinary {@link claimEscrow} path is unusable: Horizon returns the account,
 * but the network rejects the transaction for want of a fee. This splits the
 * two jobs a claim normally does — authorising it and paying for it:
 *
 *  1. the one-time key signs the inner transaction (it must be the source of
 *     the claim, so the balance is credited there);
 *  2. the fee payer wraps that signed transaction in a CAP-15 fee bump and
 *     signs the wrapper, paying the fee.
 *
 * A never-funded one-time address has no account on the ledger, and even a
 * fee-bumped transaction needs an existing source account (`tx_no_source_account`
 * is what the network answers otherwise). So when Horizon has no account for the
 * claimant, the fee payer creates it first, with the minimum balance. That is a
 * second, visible link to the fee payer — see {@link FeeBumpedClaimOptions.feePayer}.
 *
 * Failure is safe: Stellar applies a claim atomically, so a claim that fails
 * (bad predicate, unknown balance, network rejection) consumes nothing and the
 * balance stays claimable. The only state a failed attempt can leave behind is
 * the created account, which a retry simply reuses.
 *
 * The claimed value lands in the one-time account; moving it on to the user's
 * wallet is a separate transfer, deliberately not hidden inside a claim.
 */
export async function claimEscrowWithFeeBump(options: FeeBumpedClaimOptions): Promise<FeeBumpedClaimResult> {
    const { balanceId, config } = options;
    const claimant = resolveSigner(options.claimant);
    const feePayer = resolveSigner(options.feePayer);
    const server = new Horizon.Server(config.horizonUrl);

    let source = await loadAccountOrNull(server, claimant.publicKey);
    let claimantAccountCreated = false;

    if (!source) {
        await createClaimantAccount(
            server,
            feePayer,
            claimant.publicKey,
            options.claimantStartingBalance ?? DEFAULT_CLAIMANT_STARTING_BALANCE,
            config.networkPassphrase,
        );
        source = await server.loadAccount(claimant.publicKey);
        claimantAccountCreated = true;
    }

    const inner = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
    })
        .addOperation(Operation.claimClaimableBalance({ balanceId }))
        .setTimeout(180)
        .build();

    const signedInner = await signWith(inner, claimant, config.networkPassphrase);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        feePayer.publicKey,
        options.baseFee ?? BASE_FEE,
        signedInner,
        config.networkPassphrase,
    );
    const signedFeeBump = await signWith(feeBump, feePayer, config.networkPassphrase);

    const result = await server.submitTransaction(signedFeeBump);
    return {
        txHash: result.hash,
        claimantAccountCreated,
        feePayer: feePayer.publicKey,
    };
}

/** What a brand-new account needs to exist: 2 × base reserve (0.5 XLM each). */
const DEFAULT_CLAIMANT_STARTING_BALANCE = '1';

/** Just the part of a loaded account a TransactionBuilder consumes. */
type ClaimantSourceAccount = {
    accountId(): string;
    sequenceNumber(): string;
    incrementSequenceNumber(): void;
};

/** Load an account, treating only "not found" as absent — never a network error. */
async function loadAccountOrNull(
    server: Horizon.Server,
    publicKey: string,
): Promise<ClaimantSourceAccount | null> {
    try {
        return await server.loadAccount(publicKey);
    } catch (error) {
        if (isNotFound(error)) return null;
        // A 500 or a timeout must not be read as "no account": the caller would
        // create an account that already exists and fail for a different reason.
        throw error;
    }
}

function isNotFound(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | null)?.response?.status;
    return status === 404 || (error instanceof Error && error.name === 'NotFoundError');
}

/** Create the never-funded claimant account, from the fee payer. */
async function createClaimantAccount(
    server: Horizon.Server,
    feePayer: ResolvedSigner,
    destination: string,
    startingBalance: string,
    networkPassphrase: string,
): Promise<void> {
    const payerAccount = await server.loadAccount(feePayer.publicKey);
    const tx = new TransactionBuilder(payerAccount, {
        fee: BASE_FEE,
        networkPassphrase,
    })
        .addOperation(Operation.createAccount({ destination, startingBalance }))
        .setTimeout(180)
        .build();

    const signed = await signWith(tx, feePayer, networkPassphrase);
    await server.submitTransaction(signed);
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
