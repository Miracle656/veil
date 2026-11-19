/**
 * What a session key can and cannot do, proven on a real network (#1338).
 *
 * Every case is a real ed25519 signature inside a real authorisation entry,
 * submitted to the network against a wallet running the deployed wallet code.
 * Refused calls are put on the ledger anyway (see `submitWithEntries`), so each
 * refusal has a transaction hash, and the wallet's own reason is read from the
 * simulation's diagnostic events.
 *
 * Run with `npm run test:network -- sessionKeyLimits`. Set
 * VEIL_SESSION_KEY_EVIDENCE to a file path to write every case's hash there.
 */

import { writeFileSync } from 'node:fs';

import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import {
    buildRegisterSessionKeyCall,
    buildRevokeSessionKeyCall,
    readSessionKey,
    readSessionKeyNetworkLimits,
    walletAuthFailure,
} from '../../src/sessionKey';
import * as net from './harness';

const CAP = 1_000_000n;
const SESSION_KEY_EXPIRED = 19;
const SESSION_KEY_ACL_VIOLATION = 20;
const SIGNER_NOT_AUTHORIZED = 3;

type Evidence = { case: string; hash: string; status: string; reason?: string };
const evidence: Evidence[] = [];

function describeError(error: xdr.ScError | null): string | undefined {
    if (!error) return undefined;
    return error.switch().value === xdr.ScErrorType.sceContract().value
        ? `Error(Contract, #${error.contractCode()})`
        : `Error(${error.switch().name.replace(/^sce/, '')}, ${error.code().name.replace(/^scec/, '')})`;
}

describe('a session key on the deployed wallet code, on a real network', () => {
    let payer: Keypair;
    let issuer: Keypair;
    let passkey: net.SoftwarePasskey;
    let wallet: string;
    let token: string;
    let otherToken: string;
    let recipient: Keypair;
    let stranger: Keypair;

    const sessionKey = Keypair.random();
    const keyId = Keypair.random().rawPublicKey();
    const shortLivedKeyId = Keypair.random().rawPublicKey();
    let shortLivedExpiry: bigint;

    async function asOwner(call: { contractId: string; method: string; args: xdr.ScVal[] }) {
        const result = await net.submitAsWallet(
            payer, wallet, call.contractId, call.method, call.args, net.passkeySigner(passkey, wallet),
        );
        expect(result.status).toBe('SUCCESS');
        return result;
    }

    async function register(id: Uint8Array, expiry: bigint) {
        const limits = await readSessionKeyNetworkLimits(net.server);
        return asOwner(
            buildRegisterSessionKeyCall(
                wallet,
                { pubkey: sessionKey.rawPublicKey(), keyId: id, targetContract: token, selector: 'transfer', amountCap: CAP, expiry },
                limits,
            ),
        );
    }

    function transferArgs(amount: bigint, to: string) {
        return [new Address(wallet).toScVal(), new Address(to).toScVal(), nativeToScVal(amount, { type: 'i128' })];
    }

    async function sessionCall(
        contractId: string,
        method: string,
        args: xdr.ScVal[],
        signer: net.EntrySigner = net.sessionKeySigner(sessionKey, keyId, wallet),
    ) {
        return net.submitAsWallet(payer, wallet, contractId, method, args, signer);
    }

    function record(name: string, result: net.Submitted) {
        const reason = describeError(walletAuthFailure(result.ledgerEvents, wallet)) ?? result.simulationError;
        evidence.push({ case: name, hash: result.hash, status: result.status, reason });
        console.log(`${name}: ${result.status} ${result.hash}${reason ? ` (${reason})` : ''}`);
    }

    function expectRefusedBy(result: net.Submitted, expected: string) {
        expect(result.status).toBe('FAILED');
        expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
        expect(describeError(walletAuthFailure(result.simulationEvents, wallet))).toBe(expected);
        // The transaction on the ledger failed for the same reason, not for something the harness left out.
        expect(describeError(walletAuthFailure(result.ledgerEvents, wallet))).toBe(expected);
    }

    async function spent(id = keyId) {
        return (await readSessionKey(net.server, wallet, id))?.spent;
    }

    beforeAll(async () => {
        const wasm = await net.fetchDeployedWalletWasm();
        [payer, issuer, recipient, stranger] = await Promise.all([
            net.fundedAccount(),
            net.fundedAccount(),
            net.fundedAccount(),
            net.fundedAccount(),
        ]);
        await net.ensureWasmUploaded(payer, wasm);
        passkey = new net.SoftwarePasskey();
        wallet = await net.deployWallet(payer, passkey);

        token = net.nativeTokenId();
        await net.sacTransferFromAccount(payer, token, wallet, 100_000_000n);
        otherToken = await net.deployTestToken(issuer, 'VEILB');
        await net.sacMint(issuer, otherToken, wallet, 100_000_000n);

        // A second key with an expiry seconds away, checked at the end once it has passed.
        shortLivedExpiry = (await net.ledgerTime()) + 15n;
        await register(shortLivedKeyId, shortLivedExpiry);
        await register(keyId, (await net.ledgerTime()) + 3600n);
    });

    afterAll(() => {
        if (process.env.VEIL_SESSION_KEY_EVIDENCE) {
            writeFileSync(
                process.env.VEIL_SESSION_KEY_EVIDENCE,
                JSON.stringify({ network: net.NETWORK_PASSPHRASE, wallet, token, otherToken, evidence }, null, 2) + '\n',
            );
        }
    });

    it('the wallet runs the deployed wallet code', async () => {
        expect(await net.executableWasmHash(wallet)).toBe(net.DEPLOYED_WALLET_WASM_SHA256);
        expect(await spent()).toBe(0n);
    });

    it('a transfer inside the cap succeeds and spent goes up by the amount', async () => {
        const before = await net.balanceOf(token, recipient.publicKey());
        const result = await sessionCall(token, 'transfer', transferArgs(300_000n, recipient.publicKey()));
        record('transfer inside the cap', result);
        expect(result.status).toBe('SUCCESS');
        expect(await spent()).toBe(300_000n);
        expect((await net.balanceOf(token, recipient.publicKey())) - before).toBe(300_000n);
    });

    it('of several transfers adding up to more than the cap, the one that crosses it is refused', async () => {
        const second = await sessionCall(token, 'transfer', transferArgs(400_000n, recipient.publicKey()));
        record('second transfer, still inside the cap', second);
        expect(second.status).toBe('SUCCESS');
        expect(await spent()).toBe(700_000n);

        const before = await net.balanceOf(token, recipient.publicKey());
        const crossing = await sessionCall(token, 'transfer', transferArgs(400_000n, recipient.publicKey()));
        record('third transfer, crossing the cap', crossing);
        expectRefusedBy(crossing, `Error(Contract, #${SESSION_KEY_ACL_VIOLATION})`);
        expect(await spent()).toBe(700_000n);
        expect(await net.balanceOf(token, recipient.publicKey())).toBe(before);
    });

    it('a transfer of a different token is refused', async () => {
        // To the issuer, which needs no trustline, so the token contract itself has no reason to refuse.
        const result = await sessionCall(otherToken, 'transfer', transferArgs(1n, issuer.publicKey()));
        record('transfer of a different token', result);
        expectRefusedBy(result, `Error(Contract, #${SESSION_KEY_ACL_VIOLATION})`);
        expect(await spent()).toBe(700_000n);
    });

    it('a different function on the same token contract (approve) is refused', async () => {
        const { sequence } = await net.server._getLatestLedger();
        const result = await sessionCall(token, 'approve', [
            new Address(wallet).toScVal(),
            new Address(stranger.publicKey()).toScVal(),
            nativeToScVal(1n, { type: 'i128' }),
            nativeToScVal(sequence + 1000, { type: 'u32' }),
        ]);
        record('approve on the same token', result);
        expectRefusedBy(result, `Error(Contract, #${SESSION_KEY_ACL_VIOLATION})`);
        expect(await net.simulateRead(token, 'allowance', [
            new Address(wallet).toScVal(),
            new Address(stranger.publicKey()).toScVal(),
        ])).toBe(0n);
    });

    it('the right key_id signed by a different ed25519 key is refused', async () => {
        const result = await sessionCall(
            token, 'transfer', transferArgs(1n, recipient.publicKey()),
            net.sessionKeySigner(Keypair.random(), keyId, wallet),
        );
        record('right key_id, different ed25519 key', result);
        expectRefusedBy(result, 'Error(Crypto, InvalidInput)');
        expect(await spent()).toBe(700_000n);
    });

    it('a signature reused with an old nonce is refused', async () => {
        const original = await sessionCall(token, 'transfer', transferArgs(1n, recipient.publicKey()));
        record('transfer whose signature is then replayed', original);
        expect(original.status).toBe('SUCCESS');
        expect(await spent()).toBe(700_001n);

        const before = await net.balanceOf(token, recipient.publicKey());
        const replay = await net.submitWithEntries(
            payer, token, 'transfer', transferArgs(1n, recipient.publicKey()), original.signedEntries, undefined, wallet,
        );
        record('the same signed entry, replayed', replay);
        expectRefusedBy(replay, 'Error(Contract, #16)');
        expect(await spent()).toBe(700_001n);
        expect(await net.balanceOf(token, recipient.publicKey())).toBe(before);

        // A fresh signature over the same call, carrying the wallet nonce the replayed entry used.
        const staleNonce = await sessionCall(
            token, 'transfer', transferArgs(1n, recipient.publicKey()),
            net.sessionKeySigner(sessionKey, keyId, wallet, -1n),
        );
        record('fresh signature carrying the previous wallet nonce', staleNonce);
        expectRefusedBy(staleNonce, 'Error(Contract, #16)');
        expect(await spent()).toBe(700_001n);
    });

    it('a transfer inside the cap to an address the owner never named succeeds', async () => {
        const before = await net.balanceOf(token, stranger.publicKey());
        const result = await sessionCall(token, 'transfer', transferArgs(100_000n, stranger.publicKey()));
        record('transfer inside the cap to an address the owner never named', result);
        expect(result.status).toBe('SUCCESS');
        expect(await spent()).toBe(800_001n);
        expect((await net.balanceOf(token, stranger.publicKey())) - before).toBe(100_000n);
    });

    it('registering the same key_id again sets spent back to 0', async () => {
        expect(await spent()).toBe(800_001n);
        const result = await register(keyId, (await net.ledgerTime()) + 3600n);
        record('registering the same key_id again', result);
        expect(await spent()).toBe(0n);

        const spend = await sessionCall(token, 'transfer', transferArgs(CAP, recipient.publicKey()));
        record('the full cap again, after re-registering', spend);
        expect(spend.status).toBe('SUCCESS');
        expect(await spent()).toBe(CAP);
    });

    it('any call after revoke_session_key is refused', async () => {
        const reRegistered = await register(keyId, (await net.ledgerTime()) + 3600n);
        expect(reRegistered.status).toBe('SUCCESS');
        const revoke = await asOwner(buildRevokeSessionKeyCall(wallet, keyId));
        record('revoke_session_key', revoke);
        expect(await readSessionKey(net.server, wallet, keyId)).toBeNull();

        const result = await sessionCall(token, 'transfer', transferArgs(1n, recipient.publicKey()));
        record('transfer after revoke', result);
        expectRefusedBy(result, `Error(Contract, #${SIGNER_NOT_AUTHORIZED})`);
    });

    it('any call after expiry is refused', async () => {
        // The contract accepts calls until 60 seconds after expiry (clock-skew grace).
        await net.waitForLedgerTime(shortLivedExpiry + 60n);
        const stored = await readSessionKey(net.server, wallet, shortLivedKeyId);
        expect(stored?.expiry).toBe(shortLivedExpiry);
        expect(stored?.spent).toBe(0n);

        const result = await sessionCall(
            token, 'transfer', transferArgs(1n, recipient.publicKey()),
            net.sessionKeySigner(sessionKey, shortLivedKeyId, wallet),
        );
        record('transfer after expiry', result);
        expectRefusedBy(result, `Error(Contract, #${SESSION_KEY_EXPIRED})`);
    });
});
