/**
 * The SDK's session-key builders, signer and reader against the deployed
 * wallet code on a real network (testnet unless VEIL_NETWORK_RPC_URL says
 * otherwise). Run with `npm run test:network`.
 */

import { Address, Keypair, nativeToScVal } from '@stellar/stellar-sdk';

import {
    SessionKeyError,
    SessionKeyNonceMismatch,
    buildRegisterSessionKeyCall,
    buildRevokeSessionKeyCall,
    maxSessionKeyExpiry,
    readSessionKey,
    readSessionKeyNetworkLimits,
    sessionKeyRetryableError,
} from '../../src/sessionKey';
import * as net from './harness';

describe('session keys through the SDK, on the deployed wallet code', () => {
    let payer: Keypair;
    let passkey: net.SoftwarePasskey;
    let wallet: string;
    let token: string;
    const sessionKey = Keypair.random();
    const keyId = Keypair.random().rawPublicKey();
    const recipient = Keypair.random();

    beforeAll(async () => {
        const wasm = await net.fetchDeployedWalletWasm();
        payer = await net.fundedAccount();
        await net.ensureWasmUploaded(payer, wasm);
        passkey = new net.SoftwarePasskey();
        wallet = await net.deployWallet(payer, passkey);
        token = net.nativeTokenId();
        await net.sacTransferFromAccount(payer, token, wallet, 50_000_000n);
        await net.sacTransferFromAccount(payer, token, recipient.publicKey(), 10_000_000n);
    });

    async function asOwner(call: { contractId: string; method: string; args: Parameters<typeof net.submitAsWallet>[4] }) {
        return net.submitAsWallet(payer, wallet, call.contractId, call.method, call.args, net.passkeySigner(passkey, wallet));
    }

    function transferArgs(amount: bigint) {
        return [
            new Address(wallet).toScVal(),
            new Address(recipient.publicKey()).toScVal(),
            nativeToScVal(amount, { type: 'i128' }),
        ];
    }

    it('the wallet runs the deployed wallet code', async () => {
        expect(await net.executableWasmHash(wallet)).toBe(net.DEPLOYED_WALLET_WASM_SHA256);
    });

    it('reads null for a key that was never registered', async () => {
        expect(await readSessionKey(net.server, wallet, Keypair.random().rawPublicKey())).toBeNull();
    });

    it('registers a key with the passkey and reads its record back', async () => {
        const limits = await readSessionKeyNetworkLimits(net.server);
        const expiry = limits.ledgerTime + 3600n;
        const call = buildRegisterSessionKeyCall(
            wallet,
            { pubkey: sessionKey.rawPublicKey(), keyId, targetContract: token, selector: 'transfer', amountCap: 2_000_000n, expiry },
            limits,
        );
        const result = await asOwner(call);
        expect(result.status).toBe('SUCCESS');

        expect(await readSessionKey(net.server, wallet, keyId)).toEqual({
            pubkey: new Uint8Array(sessionKey.rawPublicKey()),
            targetContract: token,
            selector: 'transfer',
            amountCap: 2_000_000n,
            spent: 0n,
            expiry,
        });
    });

    it('a transfer signed by the session key lands and is counted', async () => {
        const result = await net.submitAsWallet(
            payer, wallet, token, 'transfer', transferArgs(500_000n),
            net.sessionKeySigner(sessionKey, keyId, wallet),
        );
        expect(result.status).toBe('SUCCESS');
        expect((await readSessionKey(net.server, wallet, keyId))?.spent).toBe(500_000n);
    });

    it('a stale wallet nonce is refused as NonceMismatch and classified as retryable', async () => {
        const result = await net.submitAsWallet(
            payer, wallet, token, 'transfer', transferArgs(1n),
            net.sessionKeySigner(sessionKey, keyId, wallet, -1n),
        );
        expect(result.status).toBe('FAILED');
        expect(result.simulationError).toMatch(/Error\(Auth, InvalidAction\)/);
        expect(sessionKeyRetryableError({ events: result.simulationEvents }, wallet)).toBeInstanceOf(SessionKeyNonceMismatch);
        // The transaction on the ledger was refused for the same reason, not for something the harness left out.
        expect(sessionKeyRetryableError({ events: result.ledgerEvents }, wallet)).toBeInstanceOf(SessionKeyNonceMismatch);
        expect((await readSessionKey(net.server, wallet, keyId))?.spent).toBe(500_000n);
    });

    describe('the longest expiry the network can honour', () => {
        it('registers at the SDK maximum', async () => {
            const limits = await readSessionKeyNetworkLimits(net.server);
            const longKey = Keypair.random().rawPublicKey();
            const call = buildRegisterSessionKeyCall(
                wallet,
                { pubkey: sessionKey.rawPublicKey(), keyId: longKey, targetContract: token, selector: 'transfer', amountCap: 1n, expiry: maxSessionKeyExpiry(limits) },
                limits,
            );
            expect((await asOwner(call)).status).toBe('SUCCESS');

            const { entries, latestLedger } = await net.server.getLedgerEntries(
                (await import('../../src/sessionKey')).sessionKeyLedgerKey(wallet, longKey),
            );
            expect(entries).toHaveLength(1);
            expect(entries[0].liveUntilLedgerSeq! - latestLedger).toBeLessThan(limits.maxEntryTtl);
        });

        it('the network refuses the whole registration once the contract asks for maxEntryTtl ledgers', async () => {
            const limits = await readSessionKeyNetworkLimits(net.server);
            // (expiry - now) / 5 + 10 >= maxEntryTtl, with two minutes of slack for the call to land.
            const expiry = limits.ledgerTime + (BigInt(limits.maxEntryTtl) - 10n) * 5n + 120n;
            const grant = { pubkey: sessionKey.rawPublicKey(), keyId: Keypair.random().rawPublicKey(), targetContract: token, selector: 'transfer', amountCap: 1n, expiry };

            expect(() => buildRegisterSessionKeyCall(wallet, grant, limits)).toThrow(SessionKeyError);

            const args = [
                nativeToScVal(Buffer.from(grant.pubkey), { type: 'bytes' }),
                nativeToScVal(Buffer.from(grant.keyId), { type: 'bytes' }),
                new Address(token).toScVal(),
                nativeToScVal('transfer', { type: 'symbol' }),
                nativeToScVal(1n, { type: 'i128' }),
                nativeToScVal(expiry, { type: 'u64' }),
            ];
            await expect(
                net.submitAsWallet(payer, wallet, wallet, 'register_session_key', args, net.passkeySigner(passkey, wallet)),
            ).rejects.toThrow(/Error\(Storage, InvalidAction\)/);
        });
    });

    it('revoking removes the record', async () => {
        const result = await asOwner(buildRevokeSessionKeyCall(wallet, keyId));
        expect(result.status).toBe('SUCCESS');
        expect(await readSessionKey(net.server, wallet, keyId)).toBeNull();
    });
});
