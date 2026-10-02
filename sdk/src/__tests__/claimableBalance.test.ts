import {
    buildClaimLink,
    buildEscrowClaimants,
    createEscrow,
    claimEscrow,
    reclaimEscrow,
} from '../claimableBalance';
import { Asset, Claimant } from '@stellar/stellar-sdk';

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
        expect(buildClaimLink(BALANCE_ID)).toBe(`https://app.veil.xyz/claim/${BALANCE_ID}`);
    });

    it('handles an empty balanceId', () => {
        expect(buildClaimLink('')).toBe('https://app.veil.xyz/claim/');
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
        submitTransaction.mockResolvedValue({ hash: 'mock-tx-hash', balance_id: BALANCE_ID });
    });

    it('returns balanceId + claimLink + expiresAt', async () => {
        const result = await createEscrow({
            senderKeypair: SENDER,
            recipientAddress: 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
            amount: '10',
            asset: Asset.native(),
            claimDeadlineSeconds: 3600,
            config: CONFIG,
        });
        expect(result.balanceId).toBe(BALANCE_ID);
        expect(result.claimLink).toBe(`https://app.veil.xyz/claim/${BALANCE_ID}`);
        expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
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

    it('throws when Horizon response is missing balance_id', async () => {
        const { submitTransaction } = getStellarMocks();
        // Horizon returns a response without balance_id (e.g. version mismatch)
        submitTransaction.mockResolvedValue({ hash: 'tx-hash-no-balance-id' });
        await expect(
            createEscrow({
                senderKeypair: SENDER,
                recipientAddress: 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D',
                amount: '10',
                asset: Asset.native(),
                claimDeadlineSeconds: 3600,
                config: CONFIG,
            })
        ).rejects.toThrow('missing balance_id');
    });
});

describe('claimEscrow()', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const { loadAccount, submitTransaction } = getStellarMocks();
        loadAccount.mockResolvedValue(MOCK_ACCOUNT);
        submitTransaction.mockResolvedValue({ hash: 'claim-tx-hash' });
    });

    it('submits claim operation and returns txHash', async () => {
        const result = await claimEscrow({
            claimantKeypair: CLAIMANT_KP,
            balanceId: BALANCE_ID,
            config: CONFIG,
        });
        expect(result.txHash).toBe('claim-tx-hash');
        const { submitTransaction } = getStellarMocks();
        expect(submitTransaction).toHaveBeenCalledTimes(1);
    });
});

describe('reclaimEscrow()', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const { loadAccount, submitTransaction } = getStellarMocks();
        loadAccount.mockResolvedValue(MOCK_ACCOUNT);
        submitTransaction.mockResolvedValue({ hash: 'reclaim-tx-hash' });
    });

    it('submits reclaim operation and returns txHash', async () => {
        const result = await reclaimEscrow({
            senderKeypair: SENDER,
            balanceId: BALANCE_ID,
            config: CONFIG,
        });
        expect(result.txHash).toBe('reclaim-tx-hash');
    });

    it('error propagates when Horizon returns error', async () => {
        const { submitTransaction } = getStellarMocks();
        submitTransaction.mockRejectedValue(new Error('Horizon error: claimable balance not yet claimable'));
        await expect(
            reclaimEscrow({ senderKeypair: SENDER, balanceId: BALANCE_ID, config: CONFIG })
        ).rejects.toThrow('Horizon error');
    });
});
