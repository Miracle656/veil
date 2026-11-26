/** @jest-environment node */
/**
 * Claiming from a one-time address that cannot pay its own fee.
 *
 * What matters here is not "a claim is submitted" but the split between the key
 * that authorises the claim and the account that pays for it, the fact that an
 * address which only holds a claimable balance still needs an account before a
 * fee bump can help, and that no failure anywhere consumes the balance.
 */
import {
    FeeBumpTransaction,
    Keypair,
    Networks,
    Operation,
    Asset,
    Transaction,
    TransactionBuilder,
} from '@stellar/stellar-sdk';

import { claimEscrowWithFeeBump, type FeeBumpedClaimOptions } from '../claimableBalance';
import type { TransactionSigner } from '../signer';

// The server the next `new Horizon.Server(...)` hands back. Everything else in
// the SDK stays real: the claim is built and signed for real, only the network
// is faked.
let mockCurrentServer: unknown;

jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk');
    return {
        ...actual,
        Horizon: {
            ...actual.Horizon,
            Server: jest.fn(() => mockCurrentServer),
        },
    };
});

// Fixed seeds: these tests sign locally, and a deterministic key is easier to
// read in a failure than a random one.
const ONE_TIME = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(1));
const FEE_PAYER = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(2));
const BALANCE_ID = '00000000' + 'ab'.repeat(32);

const config = {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
};

type Submitted = Transaction | FeeBumpTransaction;

function notFound(): Error {
    const error = new Error('Not Found') as Error & { response?: { status: number } };
    error.name = 'NotFoundError';
    error.response = { status: 404 };
    return error;
}

/** The part of a loaded account a TransactionBuilder reads. */
function account(publicKey: string) {
    return {
        accountId: () => publicKey,
        sequenceNumber: () => '41',
        incrementSequenceNumber: () => undefined,
    };
}

function harness(options: {
    /** Whether the one-time address already exists on the ledger. */
    claimantExists: boolean;
    submit?: (tx: Submitted) => Promise<{ hash: string }>;
}) {
    const submitted: Submitted[] = [];
    // Horizon starts answering for the one-time account only once it exists.
    let claimantExists = options.claimantExists;
    const loadAccount = jest.fn(async (publicKey: string) => {
        if (publicKey === ONE_TIME.publicKey() && !claimantExists) {
            throw notFound();
        }
        return account(publicKey);
    });
    const submitTransaction = jest.fn(async (tx: Submitted) => {
        submitted.push(tx);
        const result = await (options.submit ?? (async () => ({ hash: `hash-${submitted.length}` })))(tx);
        if (!('innerTransaction' in tx)) {
            claimantExists = true;
        }
        return result;
    });

    mockCurrentServer = { loadAccount, submitTransaction };
    return { submitted, loadAccount, submitTransaction };
}

/** The SDK's signing contract: hand the XDR over, get it back signed. */
function signerFor(keypair: Keypair): TransactionSigner {
    return {
        publicKey: keypair.publicKey(),
        signTransaction: (xdr: string) => {
            const tx = TransactionBuilder.fromXDR(xdr, config.networkPassphrase);
            tx.sign(keypair);
            return tx.toXDR();
        },
    };
}

function params(over: Partial<FeeBumpedClaimOptions> = {}): FeeBumpedClaimOptions {
    return {
        claimant: signerFor(ONE_TIME),
        feePayer: signerFor(FEE_PAYER),
        balanceId: BALANCE_ID,
        config,
        ...over,
    };
}

function isFeeBump(tx: Submitted): tx is FeeBumpTransaction {
    return 'innerTransaction' in tx;
}

describe('the one-time key authorises the claim, the fee payer pays for it', () => {
    it('wraps the one-time key signature in a fee bump signed by the fee payer', async () => {
        const { submitted } = harness({ claimantExists: true });

        const result = await claimEscrowWithFeeBump(params());

        expect(submitted).toHaveLength(1);
        const bump = submitted[0];
        if (!isFeeBump(bump)) throw new Error('expected a fee bump');

        expect(bump.feeSource).toBe(FEE_PAYER.publicKey());
        expect(bump.innerTransaction.source).toBe(ONE_TIME.publicKey());
        expect(bump.innerTransaction.operations).toHaveLength(1);
        expect(bump.innerTransaction.operations[0].type).toBe('claimClaimableBalance');
        // Both signatures are present: the claim, and the account paying for it.
        expect(bump.innerTransaction.signatures).toHaveLength(1);
        expect(bump.signatures).toHaveLength(1);
        // The inner transaction bids the minimum; the fee payer covers the rest.
        expect(bump.innerTransaction.fee).toBe('100');

        expect(result).toEqual({
            txHash: 'hash-1',
            claimantAccountCreated: false,
            feePayer: FEE_PAYER.publicKey(),
        });
    });

    it('stays inside the fee the caller is willing to bid', async () => {
        const { submitted } = harness({ claimantExists: true });

        await claimEscrowWithFeeBump(params({ baseFee: '500' }));

        const bump = submitted[0];
        if (!isFeeBump(bump)) throw new Error('expected a fee bump');
        // One claim operation, plus the fee bump itself.
        expect(bump.fee).toBe('1000');
    });
});

describe('an address that holds a balance but no XLM', () => {
    it('needs the one-time key to hold nothing: the only transaction is the claim', async () => {
        const { submitted } = harness({ claimantExists: true });

        await claimEscrowWithFeeBump(params());

        expect(submitted).toHaveLength(1);
        const inner = (submitted[0] as FeeBumpTransaction).innerTransaction;
        expect(inner.operations.map((op) => op.type)).not.toContain('createAccount');
    });

    it('has the fee payer create the account when Horizon has never seen it', async () => {
        // A never-funded address has no sequence number, so the fee bump alone
        // is not enough: the network answers tx_no_source_account.
        const { submitted } = harness({ claimantExists: false });

        const result = await claimEscrowWithFeeBump(params());

        expect(submitted).toHaveLength(2);
        const creation = submitted[0];
        if (isFeeBump(creation)) throw new Error('expected a plain transaction');
        expect(creation.source).toBe(FEE_PAYER.publicKey());
        expect(creation.operations[0].type).toBe('createAccount');
        expect(creation.operations[0]).toMatchObject({
            destination: ONE_TIME.publicKey(),
            // The SDK renders XLM amounts with seven decimals.
            startingBalance: '1.0000000',
        });

        const bump = submitted[1];
        if (!isFeeBump(bump)) throw new Error('expected a fee bump');
        expect(bump.innerTransaction.source).toBe(ONE_TIME.publicKey());
        expect(result.claimantAccountCreated).toBe(true);
    });

    it('reuses an account a previous failed attempt already created', async () => {
        const { submitted } = harness({ claimantExists: true });

        const result = await claimEscrowWithFeeBump(params());

        expect(submitted).toHaveLength(1);
        expect(result.claimantAccountCreated).toBe(false);
    });

    it('does not mistake a Horizon failure for a missing account', async () => {
        // Reading a 500 as "no account" would make the fee payer create an
        // account that already exists, and fail for the wrong reason.
        const { submitted, loadAccount } = harness({ claimantExists: true });
        loadAccount.mockRejectedValueOnce(new Error('Horizon unreachable'));

        await expect(claimEscrowWithFeeBump(params())).rejects.toThrow('Horizon unreachable');
        expect(submitted).toHaveLength(0);
    });
});

describe('a failed claim consumes nothing', () => {
    it('propagates the failure instead of reporting a claim', async () => {
        harness({
            claimantExists: true,
            submit: async () => {
                throw new Error('tx_fee_bump_inner_failed');
            },
        });

        await expect(claimEscrowWithFeeBump(params())).rejects.toThrow('tx_fee_bump_inner_failed');
    });

    it('submits the claim exactly once, so a retry is the caller decision', async () => {
        const { submitted } = harness({
            claimantExists: false,
            submit: async () => {
                if (submitted.length === 1) return { hash: 'creation' };
                throw new Error('tx_failed');
            },
        });

        await expect(claimEscrowWithFeeBump(params())).rejects.toThrow('tx_failed');

        // The account creation stands; the claim was attempted once and did not
        // consume the balance, because Stellar applies a claim atomically.
        expect(submitted).toHaveLength(2);
        expect(isFeeBump(submitted[1])).toBe(true);
    });
});

describe('signer safety', () => {
    it('refuses a signer that returns a different transaction', async () => {
        harness({ claimantExists: true });

        const other = new TransactionBuilder(account(ONE_TIME.publicKey()), {
            fee: '100',
            networkPassphrase: config.networkPassphrase,
        })
            .addOperation(
                Operation.payment({
                    destination: FEE_PAYER.publicKey(),
                    asset: Asset.native(),
                    amount: '1',
                }),
            )
            .setTimeout(30)
            .build();
        other.sign(ONE_TIME);

        await expect(
            claimEscrowWithFeeBump(
                params({
                    claimant: {
                        publicKey: ONE_TIME.publicKey(),
                        signTransaction: () => other.toXDR(),
                    },
                }),
            ),
        ).rejects.toThrow('different transaction');
    });
});
