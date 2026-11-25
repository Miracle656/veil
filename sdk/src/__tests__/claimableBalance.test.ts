import {
    buildClaimLink,
    buildEscrowClaimants,
    createEscrow,
    claimEscrow,
    reclaimEscrow,
} from '../claimableBalance';
import { Asset, Claimant, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSubmitTransaction = jest.fn();
const mockLoadAccount = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk');

    const MockKeypair = {
        fromSecret: (secret: string) => ({
            publicKey: () => secret === 'SENDER_SECRET'
                ? 'GDYLI7KL5EZXZSXVDMGD56OQG2QVZ5F5TVMUTYS2J6U5DWUXCTC472LU'
                : 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            secret: () => secret,
            sign: jest.fn(),
        }),
        random: () => MockKeypair.fromSecret('SENDER_SECRET'),
    };

    const mockLoadAccountFn = jest.fn();
    const mockSubmitTransactionFn = jest.fn();

    const MockServer = jest.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccountFn,
        submitTransaction: mockSubmitTransactionFn,
    }));

    return {
        ...actual,
        Keypair: MockKeypair,
        Horizon: {
            ...actual.Horizon,
            Server: MockServer,
        },
        TransactionBuilder: jest.fn().mockImplementation(() => ({
            addOperation: jest.fn().mockReturnThis(),
            setTimeout: jest.fn().mockReturnThis(),
            build: jest.fn().mockReturnValue({
                getClaimableBalanceId: jest.fn(() => '00000000da0d57da7d4850e7fc10d2a9d0ebc731f7afb40574c03395b17d49149b91f5be'),
                hash: jest.fn(() => Buffer.alloc(32, 1)),
                sign: jest.fn(),
                toEnvelope: jest.fn(),
                toXDR: jest.fn(() => 'mock-xdr'),
            }),
        })),
        Operation: {
            ...actual.Operation,
            createClaimableBalance: jest.fn(() => ({ type: 'createClaimableBalance' })),
            claimClaimableBalance: jest.fn(() => ({ type: 'claimClaimableBalance' })),
        },
        __mockLoadAccount: mockLoadAccountFn,
        __mockSubmitTransaction: mockSubmitTransactionFn,
    };
});

const getStellarMocks = () => {
    const m = jest.requireMock('@stellar/stellar-sdk') as {
        __mockLoadAccount: jest.Mock;
        __mockSubmitTransaction: jest.Mock;
    };
    return { loadAccount: m.__mockLoadAccount, submitTransaction: m.__mockSubmitTransaction };
};

// ── Test data ─────────────────────────────────────────────────────────────────

const CONFIG = {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
};

// Import Keypair from the mock
import { Keypair } from '@stellar/stellar-sdk';

const SENDER = Keypair.fromSecret('SENDER_SECRET') as unknown as import('@stellar/stellar-sdk').Keypair;
const CLAIMANT_KP = Keypair.fromSecret('CLAIMANT_SECRET') as unknown as import('@stellar/stellar-sdk').Keypair;
const BALANCE_ID = '00000000da0d57da7d4850e7fc10d2a9d0ebc731f7afb40574c03395b17d49149b91f5be';
const TX_HASH = '01'.repeat(32);

const MOCK_ACCOUNT = {
    accountId: () => 'GDYLI7KL5EZXZSXVDMGD56OQG2QVZ5F5TVMUTYS2J6U5DWUXCTC472LU',
    sequenceNumber: () => '100',
    incrementSequenceNumber: jest.fn(),
    sequence: '100',
    account_id: 'GDYLI7KL5EZXZSXVDMGD56OQG2QVZ5F5TVMUTYS2J6U5DWUXCTC472LU',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {},
    balances: [],
    signers: [],
    data_attr: {},
    id: 'GDYLI7KL5EZXZSXVDMGD56OQG2QVZ5F5TVMUTYS2J6U5DWUXCTC472LU',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildClaimLink()', () => {
    it('returns the correct claim URL', () => {
        expect(buildClaimLink(BALANCE_ID)).toBe(`https://app.useveilapp.xyz/claim/${BALANCE_ID}`);
    });

    it('handles an empty balanceId', () => {
        expect(buildClaimLink('')).toBe('https://app.useveilapp.xyz/claim/');
    });
});

describe('buildEscrowClaimants()', () => {
    it('returns two claimants: recipient unconditional, sender with time predicate', () => {
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const claimants = buildEscrowClaimants(
            'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            'GDYLI7KL5EZXZSXVDMGD56OQG2QVZ5F5TVMUTYS2J6U5DWUXCTC472LU',
            deadline
        );
        expect(claimants).toHaveLength(2);
        expect(claimants[0]).toBeInstanceOf(Claimant);
        expect(claimants[1]).toBeInstanceOf(Claimant);
        expect(claimants[0].destination).toBe('GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D');
        expect(claimants[1].destination).toBe('GDYLI7KL5EZXZSXVDMGD56OQG2QVZ5F5TVMUTYS2J6U5DWUXCTC472LU');
    });

    it('recipient claimant has different predicate than sender (sender has time-based)', () => {
        const claimants = buildEscrowClaimants(
            'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            'GDYLI7KL5EZXZSXVDMGD56OQG2QVZ5F5TVMUTYS2J6U5DWUXCTC472LU',
            Math.floor(Date.now() / 1000) + 3600
        );
        const recipientXDR = claimants[0].predicate.toXDR('base64');
        const senderXDR = claimants[1].predicate.toXDR('base64');
        expect(recipientXDR).not.toBe(senderXDR);
    });
});

describe('createEscrow()', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const { loadAccount, submitTransaction } = getStellarMocks();
        loadAccount.mockResolvedValue(MOCK_ACCOUNT);
        submitTransaction.mockResolvedValue({
            hash: TX_HASH,
            balance_id: BALANCE_ID,
            fee_charged: '62324',
        });
    });

    it('returns balanceId + claimLink + expiresAt + txHash', async () => {
        const result = await createEscrow({
            senderKeypair: SENDER,
            recipientAddress: 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            amount: '10',
            asset: Asset.native(),
            claimDeadlineSeconds: 3600,
            config: CONFIG,
        });
        expect(result.balanceId).toBe(BALANCE_ID);
        expect(result.claimLink).toBe(`https://app.useveilapp.xyz/claim/${BALANCE_ID}`);
        expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
        expect(result.txHash).toBe(TX_HASH);
        expect(result.feeCharged).toBe('62324');
    });

    it('calls submitTransaction once', async () => {
        const { submitTransaction } = getStellarMocks();
        await createEscrow({
            senderKeypair: SENDER,
            recipientAddress: 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            amount: '5',
            asset: Asset.native(),
            claimDeadlineSeconds: 7200,
            config: CONFIG,
        });
        expect(submitTransaction).toHaveBeenCalledTimes(1);
    });

    it('uses the mainnet inclusion-fee policy', async () => {
        await createEscrow({
            senderKeypair: SENDER,
            recipientAddress: 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            amount: '5',
            asset: Asset.native(),
            claimDeadlineSeconds: 7200,
            config: { ...CONFIG, networkPassphrase: Networks.PUBLIC },
        });
        expect(TransactionBuilder).toHaveBeenCalledWith(MOCK_ACCOUNT, {
            fee: '100000',
            networkPassphrase: Networks.PUBLIC,
        });
    });

    it('uses the deterministic balance ID when Horizon omits balance_id', async () => {
        const { submitTransaction } = getStellarMocks();
        submitTransaction.mockResolvedValue({ hash: TX_HASH });
        const result = await createEscrow({
            senderKeypair: SENDER,
            recipientAddress: 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            amount: '10',
            asset: Asset.native(),
            claimDeadlineSeconds: 3600,
            config: CONFIG,
        });
        expect(result.balanceId).toBe(BALANCE_ID);
        expect(result.txHash).toBe(TX_HASH);
    });

    it('preserves the transaction and balance IDs when submission is ambiguous', async () => {
        const { submitTransaction } = getStellarMocks();
        submitTransaction.mockRejectedValue(new Error('Horizon timed out'));
        await expect(createEscrow({
            senderKeypair: SENDER,
            recipientAddress: 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            amount: '10',
            asset: Asset.native(),
            claimDeadlineSeconds: 3600,
            config: CONFIG,
        })).rejects.toMatchObject({
            message: 'Horizon timed out',
            balanceId: BALANCE_ID,
            txHash: TX_HASH,
            expiresAt: expect.any(Number),
        });
    });

    it('preserves recovery context when a successful response has a different transaction hash', async () => {
        const { submitTransaction } = getStellarMocks();
        submitTransaction.mockResolvedValue({ hash: 'ff'.repeat(32) });
        await expect(createEscrow({
            senderKeypair: SENDER,
            recipientAddress: 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            amount: '10',
            asset: Asset.native(),
            claimDeadlineSeconds: 3600,
            config: CONFIG,
        })).rejects.toMatchObject({
            message: expect.stringContaining('different transaction hash'),
            balanceId: BALANCE_ID,
            txHash: TX_HASH,
            expiresAt: expect.any(Number),
        });
    });

    it('does not annotate a definitive Horizon rejection as ambiguous', async () => {
        const { submitTransaction } = getStellarMocks();
        const error = Object.assign(new Error('transaction rejected'), { response: { status: 400 } });
        submitTransaction.mockRejectedValue(error);
        await expect(createEscrow({
            senderKeypair: SENDER,
            recipientAddress: 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            amount: '10',
            asset: Asset.native(),
            claimDeadlineSeconds: 3600,
            config: CONFIG,
        })).rejects.toBe(error);
        expect(error).not.toHaveProperty('balanceId');
        expect(error).not.toHaveProperty('txHash');
    });
});

describe('claimEscrow()', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const { loadAccount, submitTransaction } = getStellarMocks();
        loadAccount.mockResolvedValue(MOCK_ACCOUNT);
        submitTransaction.mockResolvedValue({ hash: TX_HASH, fee_charged: '100' });
    });

    it('submits claim operation and returns txHash', async () => {
        const result = await claimEscrow({
            claimantKeypair: CLAIMANT_KP,
            balanceId: BALANCE_ID,
            config: CONFIG,
        });
        expect(result.txHash).toBe(TX_HASH);
        expect(result.feeCharged).toBe('100');
        const { submitTransaction } = getStellarMocks();
        expect(submitTransaction).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['without an HTTP status', undefined],
        ['with HTTP 500', 500],
    ])('preserves recovery context when claim submission is ambiguous %s', async (_label, status) => {
        const { submitTransaction } = getStellarMocks();
        const error = Object.assign(
            new Error('Horizon unavailable'),
            status === undefined ? {} : { response: { status } },
        );
        submitTransaction.mockRejectedValue(error);
        await expect(claimEscrow({
            claimantKeypair: CLAIMANT_KP,
            balanceId: BALANCE_ID,
            config: CONFIG,
        })).rejects.toMatchObject({
            message: 'Horizon unavailable',
            balanceId: BALANCE_ID,
            txHash: TX_HASH,
        });
        expect(submitTransaction).toHaveBeenCalledTimes(1);
    });

    it('preserves recovery context when a successful response has a different transaction hash', async () => {
        const { submitTransaction } = getStellarMocks();
        submitTransaction.mockResolvedValue({ hash: 'ff'.repeat(32) });
        await expect(claimEscrow({
            claimantKeypair: CLAIMANT_KP,
            balanceId: BALANCE_ID,
            config: CONFIG,
        })).rejects.toMatchObject({
            message: expect.stringContaining('different transaction hash'),
            balanceId: BALANCE_ID,
            txHash: TX_HASH,
        });
    });
});

describe('reclaimEscrow()', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const { loadAccount, submitTransaction } = getStellarMocks();
        loadAccount.mockResolvedValue(MOCK_ACCOUNT);
        submitTransaction.mockResolvedValue({ hash: TX_HASH, fee_charged: '100' });
    });

    it('submits reclaim operation and returns txHash', async () => {
        const result = await reclaimEscrow({
            senderKeypair: SENDER,
            balanceId: BALANCE_ID,
            config: CONFIG,
        });
        expect(result.txHash).toBe(TX_HASH);
        expect(result.feeCharged).toBe('100');
    });

    it('error propagates when Horizon returns error', async () => {
        const { submitTransaction } = getStellarMocks();
        submitTransaction.mockRejectedValue(Object.assign(
            new Error('Horizon error: claimable balance not yet claimable'),
            { response: { status: 400 } },
        ));
        await expect(
            reclaimEscrow({ senderKeypair: SENDER, balanceId: BALANCE_ID, config: CONFIG })
        ).rejects.toThrow('Horizon error');
    });

    it('preserves the transaction hash when reclaim submission is ambiguous', async () => {
        const { submitTransaction } = getStellarMocks();
        submitTransaction.mockRejectedValue(new Error('Horizon timed out'));
        await expect(reclaimEscrow({
            senderKeypair: SENDER,
            balanceId: BALANCE_ID,
            config: CONFIG,
        })).rejects.toMatchObject({ balanceId: BALANCE_ID, txHash: TX_HASH });
    });

    it('preserves recovery context when a successful response has a different transaction hash', async () => {
        const { submitTransaction } = getStellarMocks();
        submitTransaction.mockResolvedValue({ hash: 'ff'.repeat(32) });
        await expect(reclaimEscrow({
            senderKeypair: SENDER,
            balanceId: BALANCE_ID,
            config: CONFIG,
        })).rejects.toMatchObject({
            message: expect.stringContaining('different transaction hash'),
            balanceId: BALANCE_ID,
            txHash: TX_HASH,
        });
    });
});
