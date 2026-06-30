/// <reference types="jest" />
import {
    TransactionBuilder,
    Transaction,
    BASE_FEE,
    Networks,
    Account,
    Operation,
    Asset,
    Claimant,
} from '@stellar/stellar-sdk';
import { buildEscrowClaimants } from '../src/claimableBalance';

const NETWORK = Networks.TESTNET;

// Fixed valid Stellar public keys — no key generation needed in the test
// environment. These match the addresses used in other SDK unit tests.
const SENDER_PK    = 'GDYLI7KL5EZXZSXVDMGD56OQG2QVZ5F5TVMUTYS2J6U5DWUXCTC472LU';
const RECIPIENT_PK = 'GB5WLPFRSD2PQRQ37MP45JSUXA4BFLAHDZ3CSTIGXR4C7GOYHU3MZE2D';
// Use SENDER_PK as issuer to avoid inventing a third unvalidated address.
const ISSUER_PK    = SENDER_PK;
const BALANCE_ID   = '00000000da0d57da7d4850e7fc10d2a9d0ebc731f7afb40574c03395b17d49149b91f5be';

function syntheticAccount(): Account {
    return new Account(SENDER_PK, '100');
}

function roundtrip(xdr: string): Transaction {
    return TransactionBuilder.fromXDR(xdr, NETWORK) as Transaction;
}

describe('XDR roundtrip — createEscrow (createClaimableBalance)', () => {
    it('operations survive encode → decode unchanged', () => {
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const claimants = buildEscrowClaimants(RECIPIENT_PK, SENDER_PK, deadline);

        const tx = new TransactionBuilder(syntheticAccount(), {
            fee: BASE_FEE,
            networkPassphrase: NETWORK,
        })
            .addOperation(
                Operation.createClaimableBalance({
                    asset: Asset.native(),
                    amount: '10',
                    claimants,
                }),
            )
            .setTimeout(180)
            .build() as Transaction;

        const decoded = roundtrip(tx.toXDR());

        expect(decoded.operations).toHaveLength(1);
        const op = decoded.operations[0] as {
            type: string;
            asset: Asset;
            amount: string;
            claimants: Claimant[];
        };
        expect(op.type).toBe('createClaimableBalance');
        expect(op.asset.isNative()).toBe(true);
        // Stellar SDK normalizes amounts to 7 decimal places in XDR.
        expect(op.amount).toBe('10.0000000');
        expect(op.claimants).toHaveLength(2);
        expect(op.claimants[0].destination).toBe(RECIPIENT_PK);
        expect(op.claimants[1].destination).toBe(SENDER_PK);
        // Claimant predicates survive the roundtrip.
        expect(op.claimants[0].predicate.toXDR('base64')).toBe(
            claimants[0].predicate.toXDR('base64'),
        );
        expect(op.claimants[1].predicate.toXDR('base64')).toBe(
            claimants[1].predicate.toXDR('base64'),
        );
    });

    it('non-native asset roundtrips without data loss', () => {
        const deadline = Math.floor(Date.now() / 1000) + 7200;
        const asset = new Asset('USDC', ISSUER_PK);
        const claimants = buildEscrowClaimants(RECIPIENT_PK, ISSUER_PK, deadline);

        const tx = new TransactionBuilder(syntheticAccount(), {
            fee: BASE_FEE,
            networkPassphrase: NETWORK,
        })
            .addOperation(
                Operation.createClaimableBalance({ asset, amount: '100.5', claimants }),
            )
            .setTimeout(180)
            .build() as Transaction;

        const decoded = roundtrip(tx.toXDR());

        expect(decoded.operations).toHaveLength(1);
        const op = decoded.operations[0] as {
            type: string;
            asset: Asset;
            amount: string;
        };
        expect(op.type).toBe('createClaimableBalance');
        expect(op.asset.getCode()).toBe('USDC');
        expect(op.asset.getIssuer()).toBe(ISSUER_PK);
        expect(op.amount).toBe('100.5000000');
    });
});

describe('XDR roundtrip — claimEscrow (claimClaimableBalance)', () => {
    it('operations survive encode → decode unchanged', () => {
        const tx = new TransactionBuilder(syntheticAccount(), {
            fee: BASE_FEE,
            networkPassphrase: NETWORK,
        })
            .addOperation(Operation.claimClaimableBalance({ balanceId: BALANCE_ID }))
            .setTimeout(180)
            .build() as Transaction;

        const decoded = roundtrip(tx.toXDR());

        expect(decoded.operations).toHaveLength(1);
        const op = decoded.operations[0] as { type: string; balanceId: string };
        expect(op.type).toBe('claimClaimableBalance');
        expect(op.balanceId).toBe(BALANCE_ID);
    });
});

describe('XDR roundtrip — reclaimEscrow (claimClaimableBalance by sender after deadline)', () => {
    it('operations survive encode → decode unchanged', () => {
        const tx = new TransactionBuilder(syntheticAccount(), {
            fee: BASE_FEE,
            networkPassphrase: NETWORK,
        })
            .addOperation(Operation.claimClaimableBalance({ balanceId: BALANCE_ID }))
            .setTimeout(180)
            .build() as Transaction;

        const decoded = roundtrip(tx.toXDR());

        expect(decoded.operations).toHaveLength(1);
        const op = decoded.operations[0] as { type: string; balanceId: string };
        expect(op.type).toBe('claimClaimableBalance');
        expect(op.balanceId).toBe(BALANCE_ID);
    });
});

describe('XDR envelope stability', () => {
    it('re-encoding the decoded TX produces the same XDR (full envelope roundtrip)', () => {
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const claimants = buildEscrowClaimants(RECIPIENT_PK, SENDER_PK, deadline);

        const tx = new TransactionBuilder(syntheticAccount(), {
            fee: BASE_FEE,
            networkPassphrase: NETWORK,
        })
            .addOperation(
                Operation.createClaimableBalance({
                    asset: Asset.native(),
                    amount: '10',
                    claimants,
                }),
            )
            .setTimeout(180)
            .build() as Transaction;

        const xdr = tx.toXDR();
        expect(roundtrip(xdr).toXDR()).toBe(xdr);
    });

    it('claimClaimableBalance re-encoding is stable', () => {
        const tx = new TransactionBuilder(syntheticAccount(), {
            fee: BASE_FEE,
            networkPassphrase: NETWORK,
        })
            .addOperation(Operation.claimClaimableBalance({ balanceId: BALANCE_ID }))
            .setTimeout(180)
            .build() as Transaction;

        const xdr = tx.toXDR();
        expect(roundtrip(xdr).toXDR()).toBe(xdr);
    });
});
