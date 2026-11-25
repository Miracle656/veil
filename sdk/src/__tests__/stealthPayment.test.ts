import { Buffer } from 'buffer';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import {
    Account,
    Asset,
    Claimant,
    Networks,
    Operation,
    StrKey,
    Transaction,
    TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
    buildEscrowClaimants,
    claimableBalanceReserveXlm,
    createEscrow,
} from '../claimableBalance';
import {
    createStealthIdentity,
    deriveStealthAddress,
    recoverStealthSigner,
    sendStealthPayment,
} from '../stealthPayment';

jest.mock('../claimableBalance', () => ({
    ...jest.requireActual('../claimableBalance'),
    createEscrow: jest.fn(),
}));

const NETWORK = Networks.TESTNET;

function deterministicBytes(start: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_, index) => start + index);
}

const RECIPIENT_X_SECRET = Buffer.from(deterministicBytes(0)).toString('hex');
const RECIPIENT_ED_SECRET = Buffer.from(deterministicBytes(64)).toString('hex');
const RECIPIENT_SECRET = RECIPIENT_X_SECRET + RECIPIENT_ED_SECRET;
const EPHEMERAL_SECRET = deterministicBytes(32);
const RECIPIENT_X_PUBLIC_KEY = '8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f';
const RECIPIENT_ED_PUBLIC_KEY = 'bc7d5f41c4899174f001a5156e06444eac6a1fd6ccd0df1817702e42f470ddd2';
const RECIPIENT_PUBLIC_KEY = RECIPIENT_X_PUBLIC_KEY + RECIPIENT_ED_PUBLIC_KEY;
const EPHEMERAL_PUBLIC_KEY = '358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254';
const ONE_TIME_ADDRESS = 'GDXMVHQYC4EHLANKV5MZMQUUDXHQREPUSSJNUAUB3HAOTHYDVIJ5C22S';
const SENDER = 'GDYLI7KL5EZXZSXVDMGD56OQG2QVZ5F5TVMUTYS2J6U5DWUXCTC472LU';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const BALANCE_ID = '00000000da0d57da7d4850e7fc10d2a9d0ebc731f7afb40574c03395b17d49149b91f5be';

const mockedCreateEscrow = createEscrow as jest.MockedFunction<typeof createEscrow>;

function claimTransaction(balanceId = BALANCE_ID, source = ONE_TIME_ADDRESS): Transaction {
    return new TransactionBuilder(new Account(source, '1'), {
        fee: '100',
        networkPassphrase: NETWORK,
    })
        .addOperation(Operation.claimClaimableBalance({ balanceId }))
        .setTimeout(180)
        .build();
}

describe('stealth address derivation', () => {
    it('matches the fixed X25519 + Ed25519 test vector', () => {
        expect(deriveStealthAddress({
            recipientPublicKey: RECIPIENT_PUBLIC_KEY,
            ephemeralPrivateKey: EPHEMERAL_SECRET,
            networkPassphrase: NETWORK,
        })).toEqual({
            address: ONE_TIME_ADDRESS,
            ephemeralPublicKey: EPHEMERAL_PUBLIC_KEY,
        });
    });

    it('does not let the sender sign with a key derived from the shared secret', () => {
        const recipientX25519PublicKey = Uint8Array.from(
            RECIPIENT_X_PUBLIC_KEY.match(/.{2}/g)!,
            (byte) => Number.parseInt(byte, 16),
        );
        const sharedSecret = x25519.getSharedSecret(EPHEMERAL_SECRET, recipientX25519PublicKey);
        const senderDerivablePublicKey = ed25519.getPublicKey(sha256(sharedSecret));
        expect(StrKey.encodeEd25519PublicKey(senderDerivablePublicKey)).not.toBe(ONE_TIME_ADDRESS);

        const signer = recoverStealthSigner({
            secretKey: RECIPIENT_SECRET,
            ephemeralPublicKey: EPHEMERAL_PUBLIC_KEY,
            oneTimeAddress: ONE_TIME_ADDRESS,
            balanceId: BALANCE_ID,
            networkPassphrase: NETWORK,
        });
        const transaction = claimTransaction();
        const signed = TransactionBuilder.fromXDR(
            signer.signTransaction(transaction.toXDR(), { networkPassphrase: NETWORK }),
            NETWORK,
        ) as Transaction;
        const signature = Buffer.from(signed.signatures[0].signature());
        expect(ed25519.verify(
            signature.toString('hex') as unknown as Parameters<typeof ed25519.verify>[0],
            transaction.hash().toString('hex') as unknown as Parameters<typeof ed25519.verify>[1],
            Buffer.from(senderDerivablePublicKey).toString('hex') as unknown as Parameters<typeof ed25519.verify>[2],
        )).toBe(false);
    });

    it('round-trips the deterministic balance ID through a real transaction envelope', () => {
        const transaction = new TransactionBuilder(new Account(SENDER, '1'), {
            fee: '100',
            networkPassphrase: NETWORK,
        })
            .addOperation(Operation.createClaimableBalance({
                asset: Asset.native(),
                amount: '0.0000001',
                claimants: buildEscrowClaimants(ONE_TIME_ADDRESS, SENDER, 2_000_000_000),
            }))
            .setTimeout(180)
            .build();
        const balanceId = transaction.getClaimableBalanceId(0);
        const decoded = TransactionBuilder.fromXDR(transaction.toXDR(), NETWORK) as Transaction;
        expect(balanceId).toMatch(/^[0-9a-f]{72}$/);
        expect(decoded.getClaimableBalanceId(0)).toBe(balanceId);
    });

    it('recovers a callback signer without the ephemeral secret', () => {
        const signer = recoverStealthSigner({
            secretKey: RECIPIENT_SECRET,
            ephemeralPublicKey: EPHEMERAL_PUBLIC_KEY,
            oneTimeAddress: ONE_TIME_ADDRESS,
            balanceId: BALANCE_ID,
            networkPassphrase: NETWORK,
        });
        expect(signer.publicKey).toBe(ONE_TIME_ADDRESS);
        expect(signer.address).toBe(ONE_TIME_ADDRESS);
        expect(signer.balanceId).toBe(BALANCE_ID);
        expect(signer).not.toHaveProperty('secret');

        const transaction = claimTransaction();
        const signed = TransactionBuilder.fromXDR(
            signer.signTransaction(transaction.toXDR(), { networkPassphrase: NETWORK }),
            NETWORK,
        ) as Transaction;
        expect(signed.signatures).toHaveLength(1);
        const signature = Buffer.from(signed.signatures[0].signature());
        const publicKey = Buffer.from(StrKey.decodeEd25519PublicKey(ONE_TIME_ADDRESS));
        expect(ed25519.verify(
            signature.toString('hex') as unknown as Parameters<typeof ed25519.verify>[0],
            transaction.hash().toString('hex') as unknown as Parameters<typeof ed25519.verify>[1],
            publicKey.toString('hex') as unknown as Parameters<typeof ed25519.verify>[2],
        )).toBe(true);
        expect(() => signer.signTransaction(transaction.toXDR(), {
            networkPassphrase: Networks.PUBLIC,
        })).toThrow('different Stellar network');
    });

    it('only signs the bound claim from the one-time address', () => {
        const signer = recoverStealthSigner({
            secretKey: RECIPIENT_SECRET,
            ephemeralPublicKey: EPHEMERAL_PUBLIC_KEY,
            oneTimeAddress: ONE_TIME_ADDRESS,
            balanceId: BALANCE_ID,
            networkPassphrase: NETWORK,
        });
        const payment = new TransactionBuilder(new Account(ONE_TIME_ADDRESS, '1'), {
            fee: '100',
            networkPassphrase: NETWORK,
        })
            .addOperation(Operation.payment({ destination: SENDER, asset: Asset.native(), amount: '1' }))
            .setTimeout(180)
            .build();
        expect(() => signer.signTransaction(payment.toXDR(), { networkPassphrase: NETWORK }))
            .toThrow('only sign a claimable-balance claim');
        expect(() => signer.signTransaction(claimTransaction('00'.repeat(36)).toXDR(), { networkPassphrase: NETWORK }))
            .toThrow('bound claimable balance');
        expect(() => signer.signTransaction(claimTransaction(BALANCE_ID, SENDER).toXDR(), { networkPassphrase: NETWORK }))
            .toThrow('its own address');
        const sourceOverride = new TransactionBuilder(new Account(ONE_TIME_ADDRESS, '1'), {
            fee: '100',
            networkPassphrase: NETWORK,
        })
            .addOperation(Operation.claimClaimableBalance({ balanceId: BALANCE_ID, source: SENDER }))
            .setTimeout(180)
            .build();
        expect(() => signer.signTransaction(sourceOverride.toXDR(), { networkPassphrase: NETWORK }))
            .toThrow('claim from its own address');
    });

    it('creates independent identities and one-time addresses', () => {
        const first = createStealthIdentity();
        const second = createStealthIdentity();
        expect(first.publicKey).toMatch(/^[0-9a-f]{128}$/);
        expect(first.secretKey).toMatch(/^[0-9a-f]{128}$/);
        expect(first.publicKey).not.toBe(second.publicKey);

        const firstAddress = deriveStealthAddress({ recipientPublicKey: first.publicKey, networkPassphrase: NETWORK });
        const secondAddress = deriveStealthAddress({ recipientPublicKey: first.publicKey, networkPassphrase: NETWORK });
        expect(firstAddress.address).not.toBe(secondAddress.address);
        expect(recoverStealthSigner({
            secretKey: first.secretKey,
            ephemeralPublicKey: firstAddress.ephemeralPublicKey,
            oneTimeAddress: firstAddress.address,
            balanceId: BALANCE_ID,
            networkPassphrase: NETWORK,
        }).publicKey).toBe(firstAddress.address);
    });

    it('rejects the wrong receiver, network, claimant address, or malformed balance ID', () => {
        const other = createStealthIdentity();
        const options = {
            secretKey: RECIPIENT_SECRET,
            ephemeralPublicKey: EPHEMERAL_PUBLIC_KEY,
            oneTimeAddress: ONE_TIME_ADDRESS,
            balanceId: BALANCE_ID,
            networkPassphrase: NETWORK,
        };
        expect(() => recoverStealthSigner({ ...options, secretKey: other.secretKey })).toThrow('does not match');
        expect(() => recoverStealthSigner({ ...options, networkPassphrase: Networks.PUBLIC })).toThrow('does not match');
        expect(() => recoverStealthSigner({ ...options, oneTimeAddress: SENDER })).toThrow('does not match');
        expect(() => recoverStealthSigner({ ...options, balanceId: '00'.repeat(33) })).toThrow('72 hexadecimal');
        expect(recoverStealthSigner({ ...options, balanceId: '00'.repeat(36) }).balanceId).toBe('00'.repeat(36));
    });

    it('rejects malformed, low-order, and invalid public keys', () => {
        expect(() => deriveStealthAddress({ recipientPublicKey: 'abcd', networkPassphrase: NETWORK }))
            .toThrow('128 hexadecimal');
        expect(() => deriveStealthAddress({
            recipientPublicKey: '00'.repeat(32) + RECIPIENT_ED_PUBLIC_KEY,
            networkPassphrase: NETWORK,
        })).toThrow('valid X25519');
        expect(() => deriveStealthAddress({
            recipientPublicKey: RECIPIENT_X_PUBLIC_KEY + 'ff'.repeat(32),
            networkPassphrase: NETWORK,
        })).toThrow('invalid Ed25519');
        expect(() => deriveStealthAddress({
            recipientPublicKey: RECIPIENT_X_PUBLIC_KEY + `01${'00'.repeat(31)}`,
            networkPassphrase: NETWORK,
        })).toThrow('invalid Ed25519');
        expect(() => recoverStealthSigner({
            secretKey: RECIPIENT_X_SECRET,
            ephemeralPublicKey: EPHEMERAL_PUBLIC_KEY,
            oneTimeAddress: ONE_TIME_ADDRESS,
            balanceId: BALANCE_ID,
            networkPassphrase: NETWORK,
        })).toThrow('128 hexadecimal');
        expect(() => recoverStealthSigner({
            secretKey: RECIPIENT_SECRET,
            ephemeralPublicKey: '00'.repeat(32),
            oneTimeAddress: ONE_TIME_ADDRESS,
            balanceId: BALANCE_ID,
            networkPassphrase: NETWORK,
        })).toThrow('valid X25519');
        expect(() => deriveStealthAddress({
            recipientPublicKey: RECIPIENT_PUBLIC_KEY,
            ephemeralPrivateKey: new Uint8Array(31),
            networkPassphrase: NETWORK,
        })).toThrow('exactly 32 bytes');
    });
});

describe('sendStealthPayment()', () => {
    beforeEach(() => {
        mockedCreateEscrow.mockReset();
        mockedCreateEscrow.mockResolvedValue({
            balanceId: BALANCE_ID,
            claimLink: `https://app.veil.xyz/claim/${BALANCE_ID}`,
            expiresAt: 2_000_000_000,
            txHash: 'create-transaction-hash',
            feeCharged: '100',
        });
    });

    it('creates a claimable balance for the derived one-time address', async () => {
        const result = await sendStealthPayment({
            sender: { publicKey: SENDER, signTransaction: jest.fn() },
            recipientPublicKey: RECIPIENT_PUBLIC_KEY,
            amount: '0.0000001',
            asset: new Asset('USDC', USDC_ISSUER),
            claimDeadlineSeconds: 3600,
            fee: '100000',
            config: { horizonUrl: 'https://horizon.stellar.org', networkPassphrase: Networks.PUBLIC },
        });

        expect(mockedCreateEscrow).toHaveBeenCalledWith(expect.objectContaining({
            recipientAddress: expect.stringMatching(/^G[A-Z2-7]{55}$/),
            amount: '0.0000001',
            claimDeadlineSeconds: 3600,
            fee: '100000',
        }));
        expect(mockedCreateEscrow.mock.calls[0][0]).not.toHaveProperty('recipientPublicKey');
        expect(result).toEqual(expect.objectContaining({
            balanceId: BALANCE_ID,
            txHash: 'create-transaction-hash',
            address: expect.stringMatching(/^G[A-Z2-7]{55}$/),
            ephemeralPublicKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        }));
    });

    it.each([
        'Horizon timed out',
        'Horizon returned a different transaction hash for the claimable-balance creation.',
    ])('preserves the derived claimant when creation has recovery context: %s', async (message) => {
        const error = Object.assign(new Error(message), {
            balanceId: BALANCE_ID,
            txHash: '01'.repeat(32),
            expiresAt: 2_000_000_000,
        }) as Error & { address?: string; ephemeralPublicKey?: string };
        mockedCreateEscrow.mockRejectedValue(error);
        await expect(sendStealthPayment({
            sender: { publicKey: SENDER, signTransaction: jest.fn() },
            recipientPublicKey: RECIPIENT_PUBLIC_KEY,
            amount: '0.0000001',
            asset: Asset.native(),
            claimDeadlineSeconds: 3600,
            config: { horizonUrl: 'https://horizon.stellar.org', networkPassphrase: Networks.PUBLIC },
        })).rejects.toBe(error);
        expect(error.address).toBe(mockedCreateEscrow.mock.calls[0][0].recipientAddress);
        expect(error.ephemeralPublicKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not label a definitive creation failure as ambiguous', async () => {
        const error = new Error('Horizon rejected the transaction');
        mockedCreateEscrow.mockRejectedValue(error);
        await expect(sendStealthPayment({
            sender: { publicKey: SENDER, signTransaction: jest.fn() },
            recipientPublicKey: RECIPIENT_PUBLIC_KEY,
            amount: '0.0000001',
            asset: Asset.native(),
            claimDeadlineSeconds: 3600,
            config: { horizonUrl: 'https://horizon.stellar.org', networkPassphrase: Networks.PUBLIC },
        })).rejects.toBe(error);
        expect(error).not.toHaveProperty('address');
    });
});

describe('claimable-balance custody and reclaim predicate', () => {
    it('reserves one base reserve per claimant for native and issued assets', () => {
        expect(claimableBalanceReserveXlm()).toBe(1);
        expect(claimableBalanceReserveXlm(0.5)).toBe(1);
        expect(() => claimableBalanceReserveXlm(-1)).toThrow('non-negative');
        expect(() => claimableBalanceReserveXlm(Number.NaN)).toThrow('finite');
    });

    it('allows only the receiver before the deadline and only the sender at or after it', () => {
        const deadline = 2_000_000_000;
        const [receiver, sender] = buildEscrowClaimants(ONE_TIME_ADDRESS, SENDER, deadline);
        expect(receiver.destination).toBe(ONE_TIME_ADDRESS);
        expect(sender.destination).toBe(SENDER);
        expect(receiver.predicate.toXDR('base64')).toBe(
            Claimant.predicateUnconditional().toXDR('base64'),
        );
        expect(sender.predicate.toXDR('base64')).toBe(
            Claimant.predicateNot(
                Claimant.predicateBeforeAbsoluteTime(deadline.toString()),
            ).toXDR('base64'),
        );
    });

    it('rejects non-positive claim windows', () => {
        expect(() => buildEscrowClaimants(ONE_TIME_ADDRESS, SENDER, 0)).toThrow('positive Unix');
    });
});
