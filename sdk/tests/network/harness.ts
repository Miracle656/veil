/**
 * Test harness for running the deployed wallet code on a real Soroban network.
 *
 * Nothing here mocks the chain. The wallet is deployed from the exact bytes
 * mainnet runs (fetched from mainnet by hash and re-hashed locally before use),
 * its owner is a software P-256 passkey that produces the same WebAuthn
 * assertion shape a phone does, and every call goes through simulation,
 * signing and submission on the network named by VEIL_NETWORK_RPC_URL.
 */

import { createHash, generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';

import {
    Account,
    Address,
    Asset,
    BASE_FEE,
    Contract,
    Keypair,
    Networks,
    Operation,
    TransactionBuilder,
    hash,
    nativeToScVal,
    rpc,
    scValToNative,
    xdr,
    type Transaction,
} from '@stellar/stellar-sdk';

import { assertEntryAuthorized, hostFunctionCalls } from '../../src/authEntryGuard';
import { sessionKeyLedgerKey, signAuthEntryWithSessionKey } from '../../src/sessionKey';
import { buildWebAuthnSignatureVector } from '../../src/signatureVector';

/** SHA-256 of the wallet WASM every Veil wallet on mainnet runs (source: commit ccebd01a9b71c9857e6cd1e05dbdf6d45ea38ba2). */
export const DEPLOYED_WALLET_WASM_SHA256 = 'b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5';

export const MAINNET_RPC_URL = process.env.VEIL_MAINNET_RPC_URL ?? 'https://mainnet.sorobanrpc.com';
export const RPC_URL = process.env.VEIL_NETWORK_RPC_URL ?? 'https://soroban-testnet.stellar.org';
export const NETWORK_PASSPHRASE = process.env.VEIL_NETWORK_PASSPHRASE ?? Networks.TESTNET;
export const FRIENDBOT_URL = process.env.VEIL_FRIENDBOT_URL ?? 'https://friendbot.stellar.org';

export const RP_ID = 'localhost';
export const ORIGIN = 'http://localhost';

export const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });

const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

export function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

/** The deployed wallet bytecode, read from mainnet by its hash and checked against it. */
export async function fetchDeployedWalletWasm(): Promise<Buffer> {
    const mainnet = new rpc.Server(MAINNET_RPC_URL);
    const key = xdr.LedgerKey.contractCode(
        new xdr.LedgerKeyContractCode({ hash: Buffer.from(DEPLOYED_WALLET_WASM_SHA256, 'hex') }),
    );
    const { entries } = await mainnet.getLedgerEntries(key);
    if (entries.length !== 1) throw new Error('The deployed wallet WASM is not on mainnet under its hash.');
    const code = Buffer.from(entries[0].val.contractCode().code());
    const actual = sha256Hex(code);
    if (actual !== DEPLOYED_WALLET_WASM_SHA256) {
        throw new Error(`Mainnet returned WASM hashing to ${actual}, not ${DEPLOYED_WALLET_WASM_SHA256}.`);
    }
    return code;
}

/** The SHA-256 of the WASM a contract instance actually executes, read from the ledger. */
export async function executableWasmHash(contractId: string): Promise<string> {
    const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
            contract: new Address(contractId).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent(),
        }),
    );
    const { entries } = await server.getLedgerEntries(key);
    if (entries.length !== 1) throw new Error(`No contract instance for ${contractId}.`);
    const executable = entries[0].val.contractData().val().instance().executable();
    if (executable.switch().value !== xdr.ContractExecutableType.contractExecutableWasm().value) {
        throw new Error(`${contractId} is not a WASM contract.`);
    }
    const wasmHash = Buffer.from(executable.wasmHash()).toString('hex');

    // Do not take the instance's word for it: hash the bytecode it points at.
    const code = await server.getLedgerEntries(
        xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, 'hex') })),
    );
    if (code.entries.length !== 1) throw new Error(`No contract code under ${wasmHash}.`);
    const recomputed = sha256Hex(code.entries[0].val.contractCode().code());
    if (recomputed !== wasmHash) throw new Error(`Code under ${wasmHash} hashes to ${recomputed}.`);
    return recomputed;
}

export async function fundedAccount(): Promise<Keypair> {
    const kp = Keypair.random();
    const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(kp.publicKey())}`);
    if (!res.ok) throw new Error(`Friendbot refused ${kp.publicKey()}: ${res.status} ${await res.text()}`);
    return kp;
}

/** A WebAuthn passkey held in memory. Produces the same assertion shape a platform authenticator does. */
export class SoftwarePasskey {
    readonly publicKey: Uint8Array;
    private readonly privateKey: KeyObject;

    constructor() {
        const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const jwk = publicKey.export({ format: 'jwk' });
        this.publicKey = Buffer.concat([
            Buffer.from([0x04]),
            Buffer.from(jwk.x as string, 'base64url'),
            Buffer.from(jwk.y as string, 'base64url'),
        ]);
        this.privateKey = privateKey;
    }

    assert(payload: Uint8Array) {
        // rpIdHash ‖ flags (UP | UV) ‖ signCount
        const authData = Buffer.concat([
            createHash('sha256').update(RP_ID).digest(),
            Buffer.from([0x05]),
            Buffer.from([0, 0, 0, 1]),
        ]);
        const clientDataJSON = Buffer.from(
            JSON.stringify({
                type: 'webauthn.get',
                challenge: Buffer.from(payload).toString('base64url'),
                origin: ORIGIN,
                crossOrigin: false,
            }),
        );
        const signedData = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
        const der = nodeSign('sha256', signedData, { key: this.privateKey, dsaEncoding: 'ieee-p1363' });
        const r = der.subarray(0, 32);
        let s = BigInt('0x' + der.subarray(32).toString('hex'));
        if (s > P256_ORDER / 2n) s = P256_ORDER - s;
        const signature = Buffer.concat([r, Buffer.from(s.toString(16).padStart(64, '0'), 'hex')]);
        return { publicKey: this.publicKey, authData, clientDataJSON, signature };
    }
}

export function authPayloadHash(entry: xdr.SorobanAuthorizationEntry, validUntilLedger: number): Buffer {
    const cred = entry.credentials().address();
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
            networkId: hash(Buffer.from(NETWORK_PASSPHRASE)),
            nonce: cred.nonce(),
            invocation: entry.rootInvocation(),
            signatureExpirationLedger: validUntilLedger,
        }),
    );
    return hash(preimage.toXDR());
}

export function withSignature(
    entry: xdr.SorobanAuthorizationEntry,
    validUntilLedger: number,
    signature: xdr.ScVal,
): xdr.SorobanAuthorizationEntry {
    const cred = entry.credentials().address();
    return new xdr.SorobanAuthorizationEntry({
        rootInvocation: entry.rootInvocation(),
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
            new xdr.SorobanAddressCredentials({
                address: cred.address(),
                nonce: cred.nonce(),
                signatureExpirationLedger: validUntilLedger,
                signature,
            }),
        ),
    });
}

export async function readWalletNonce(walletId: string): Promise<bigint> {
    const value = await simulateRead(walletId, 'get_nonce', []);
    return BigInt(value as bigint | number);
}

export async function simulateRead(contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
    const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), '0'), {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(30)
        .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`${method} simulation failed: ${sim.error}`);
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    return retval ? scValToNative(retval) : undefined;
}

export type Submitted = {
    hash: string;
    status: 'SUCCESS' | 'FAILED';
    /** The enforce-mode simulation error, when the network refused before inclusion would have. */
    simulationError?: string;
    /** Diagnostic events from that simulation. A contract's error inside `__check_auth` is only visible here. */
    simulationEvents?: xdr.DiagnosticEvent[];
    /** Diagnostic events of the transaction as the ledger ran it, when the RPC returns them. */
    ledgerEvents?: xdr.DiagnosticEvent[];
    returnValue?: xdr.ScVal;
};

/** Sign one wallet auth entry: given the entry and the ledger it is valid until, return the credential ScVal. */
export type EntrySigner = (
    entry: xdr.SorobanAuthorizationEntry,
    validUntilLedger: number,
    allowed: xdr.InvokeContractArgs[],
) => Promise<xdr.ScVal> | xdr.ScVal;

const POLL_INTERVAL_MS = 1000;

async function poll(txHash: string): Promise<rpc.Api.GetTransactionResponse> {
    for (let i = 0; i < 60; i++) {
        const res = await server.getTransaction(txHash);
        if (res.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return res;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Transaction ${txHash} was not included within a minute.`);
}

async function sendAndWait(tx: Transaction): Promise<rpc.Api.GetTransactionResponse & { hash: string }> {
    const sent = await server.sendTransaction(tx);
    if (sent.status === 'ERROR') {
        throw new Error(`sendTransaction rejected ${sent.hash}: ${sent.errorResult?.toXDR('base64')}`);
    }
    const res = await poll(sent.hash);
    return Object.assign(res, { hash: sent.hash });
}

/** Submit a classic or already-prepared transaction from `source`. */
export async function submitPlain(source: Keypair, op: xdr.Operation): Promise<Submitted> {
    const account = await server.getAccount(source.publicKey());
    let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(op)
        .setTimeout(60)
        .build();
    if (op.body().switch().value === xdr.OperationType.invokeHostFunction().value) {
        tx = await server.prepareTransaction(tx);
    }
    tx.sign(source);
    const res = await sendAndWait(tx);
    if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Setup transaction ${res.hash} failed.`);
    }
    return { hash: res.hash, status: 'SUCCESS', returnValue: res.returnValue };
}

/**
 * Call `method` on `contractId` with the wallet's auth entries signed by `signEntry`,
 * the way a client does: record, check each entry against the call, sign, re-simulate
 * in enforce mode, submit.
 *
 * When the enforce-mode simulation refuses, the transaction is still sent, with the
 * footprint from recording mode widened to everything `__check_auth` touches, so
 * the refusal is recorded on the ledger with a hash rather than only in a simulation.
 */
export async function submitAsWallet(
    feePayer: Keypair,
    walletId: string,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    signEntry: EntrySigner,
    options: { tamper?: (entries: xdr.SorobanAuthorizationEntry[]) => xdr.SorobanAuthorizationEntry[] } = {},
): Promise<Submitted & { signedEntries: xdr.SorobanAuthorizationEntry[] }> {
    const account = await server.getAccount(feePayer.publicKey());
    const unsigned = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(60)
        .build();

    const recorded = await server.simulateTransaction(unsigned);
    if (rpc.Api.isSimulationError(recorded)) throw new Error(`Recording simulation failed: ${recorded.error}`);
    const success = recorded as rpc.Api.SimulateTransactionSuccessResponse;
    const allowed = hostFunctionCalls(unsigned);
    const { sequence } = await server._getLatestLedger();
    const validUntil = sequence + 60;

    let signedEntries: xdr.SorobanAuthorizationEntry[] = [];
    for (const entry of success.result?.auth ?? []) {
        if (entry.credentials().switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
            signedEntries.push(entry);
            continue;
        }
        assertEntryAuthorized(entry, { walletAddress: walletId, allowed });
        signedEntries.push(withSignature(entry, validUntil, await signEntry(entry, validUntil, allowed)));
    }
    if (options.tamper) signedEntries = options.tamper(signedEntries);

    return submitWithEntries(feePayer, contractId, method, args, signedEntries, success, walletId);
}

/** Submit a call carrying exactly `entries` as its authorization. */
export async function submitWithEntries(
    feePayer: Keypair,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    entries: xdr.SorobanAuthorizationEntry[],
    recorded: rpc.Api.SimulateTransactionSuccessResponse | undefined,
    walletId: string,
    extraFootprint: xdr.LedgerKey[] = [],
): Promise<Submitted & { signedEntries: xdr.SorobanAuthorizationEntry[] }> {
    const account = await server.getAccount(feePayer.publicKey());
    const op = Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
                contractAddress: new Address(contractId).toScAddress(),
                functionName: method,
                args,
            }),
        ),
        auth: entries,
    });
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(op)
        .setTimeout(60)
        .build();

    const enforced = await server.simulateTransaction(tx);
    if (!rpc.Api.isSimulationError(enforced)) {
        const prepared = rpc.assembleTransaction(tx, enforced).build();
        prepared.sign(feePayer);
        const res = await sendAndWait(prepared);
        return {
            hash: res.hash,
            status: res.status === rpc.Api.GetTransactionStatus.SUCCESS ? 'SUCCESS' : 'FAILED',
            returnValue: res.status === rpc.Api.GetTransactionStatus.SUCCESS ? res.returnValue : undefined,
            ledgerEvents: 'diagnosticEventsXdr' in res ? res.diagnosticEventsXdr : undefined,
            signedEntries: entries,
        };
    }

    // Refused in simulation. Put it on the ledger anyway so the refusal has a hash.
    if (!recorded) {
        const rec = await server.simulateTransaction(
            new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
                .addOperation(new Contract(contractId).call(method, ...args))
                .setTimeout(60)
                .build(),
        );
        if (rpc.Api.isSimulationError(rec)) throw new Error(`Recording simulation failed: ${rec.error}`);
        recorded = rec as rpc.Api.SimulateTransactionSuccessResponse;
    }
    const data = recorded.transactionData.build();
    const resources = data.resources();
    const footprint = resources.footprint();
    const readWrite = [...footprint.readWrite(), ...walletFootprint(walletId, entries), ...extraFootprint];
    const seen = new Set<string>();
    const rw = readWrite.filter((k) => {
        const id = k.toXDR('base64');
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
    const ro = footprint.readOnly().filter((k) => !seen.has(k.toXDR('base64')));
    const widened = new xdr.SorobanTransactionData({
        ext: new xdr.SorobanTransactionDataExt(0),
        resourceFee: new xdr.Int64(50_000_000),
        resources: new xdr.SorobanResources({
            footprint: new xdr.LedgerFootprint({ readOnly: ro, readWrite: rw }),
            instructions: 50_000_000,
            diskReadBytes: 200_000,
            writeBytes: 50_000,
        }),
    });
    const forced = new TransactionBuilder(await server.getAccount(feePayer.publicKey()), {
        fee: (50_000_000 + 10_000).toString(),
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(op)
        .setSorobanData(widened)
        .setTimeout(60)
        .build();
    forced.sign(feePayer);
    const res = await sendAndWait(forced);
    return {
        hash: res.hash,
        status: res.status === rpc.Api.GetTransactionStatus.SUCCESS ? 'SUCCESS' : 'FAILED',
        simulationError: enforced.error,
        simulationEvents: enforced.events,
        ledgerEvents: 'diagnosticEventsXdr' in res ? res.diagnosticEventsXdr : undefined,
        signedEntries: entries,
    };
}

/**
 * Wallet storage `__check_auth` may read or write, whichever branch runs.
 *
 * Recording-mode simulation does not run `__check_auth`, so none of this is in
 * its footprint. Without it the forced transaction fails on an undeclared
 * storage read before the wallet reaches the check being tested. That includes
 * the session key's record, which the wallet loads before anything else.
 */
function walletFootprint(walletId: string, entries: xdr.SorobanAuthorizationEntry[]): xdr.LedgerKey[] {
    const sessionKeyRecords = entries.flatMap((entry) => {
        if (entry.credentials().switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) return [];
        const credential = entry.credentials().address();
        if (Address.fromScAddress(credential.address()).toString() !== walletId) return [];
        const items = credential.signature().switch().value === xdr.ScValType.scvVec().value ? credential.signature().vec() ?? [] : [];
        if (items.length !== 3 || items[0].switch().value !== xdr.ScValType.scvBytes().value) return [];
        return [sessionKeyLedgerKey(walletId, items[0].bytes())];
    });
    return [
        ...sessionKeyRecords,
        xdr.LedgerKey.contractData(
            new xdr.LedgerKeyContractData({
                contract: new Address(walletId).toScAddress(),
                key: xdr.ScVal.scvLedgerKeyContractInstance(),
                durability: xdr.ContractDataDurability.persistent(),
            }),
        ),
        xdr.LedgerKey.contractCode(
            new xdr.LedgerKeyContractCode({ hash: Buffer.from(DEPLOYED_WALLET_WASM_SHA256, 'hex') }),
        ),
    ];
}

/** Sign wallet auth entries with a session key, through the SDK signer. `nonceOffset` signs against a nonce other than the current one. */
export function sessionKeySigner(sessionKey: Keypair, keyId: Uint8Array, walletId: string, nonceOffset = 0n): EntrySigner {
    return async (entry, validUntil, allowed) => {
        const walletNonce = (await readWalletNonce(walletId)) + nonceOffset;
        return signAuthEntryWithSessionKey(entry, {
            sessionKey,
            keyId,
            walletAddress: walletId,
            allowed,
            walletNonce,
            validUntilLedger: validUntil,
            networkPassphrase: NETWORK_PASSPHRASE,
        }).signature;
    };
}

/** Sign wallet auth entries with the owner's passkey. */
export function passkeySigner(passkey: SoftwarePasskey, walletId: string): EntrySigner {
    return async (entry, validUntil) => {
        const nonce = await readWalletNonce(walletId);
        return buildWebAuthnSignatureVector(passkey.assert(authPayloadHash(entry, validUntil)), nonce);
    };
}

export async function ensureWasmUploaded(source: Keypair, wasm: Buffer): Promise<void> {
    const key = xdr.LedgerKey.contractCode(
        new xdr.LedgerKeyContractCode({ hash: Buffer.from(DEPLOYED_WALLET_WASM_SHA256, 'hex') }),
    );
    const { entries } = await server.getLedgerEntries(key);
    if (entries.length === 1) return;
    await submitPlain(source, Operation.uploadContractWasm({ wasm }));
}

/** Deploy a wallet from the deployed WASM and initialise it with `passkey` as its only signer. */
export async function deployWallet(source: Keypair, passkey: SoftwarePasskey): Promise<string> {
    const salt = Buffer.from(Keypair.random().rawPublicKey());
    const deployed = await submitPlain(
        source,
        Operation.createCustomContract({
            address: new Address(source.publicKey()),
            wasmHash: Buffer.from(DEPLOYED_WALLET_WASM_SHA256, 'hex'),
            salt,
        }),
    );
    const walletId = Address.fromScVal(deployed.returnValue!).toString();
    await submitPlain(
        source,
        new Contract(walletId).call(
            'init',
            nativeToScVal(Buffer.from(passkey.publicKey), { type: 'bytes' }),
            nativeToScVal(Buffer.from(RP_ID), { type: 'bytes' }),
            nativeToScVal(Buffer.from(ORIGIN), { type: 'bytes' }),
        ),
    );
    return walletId;
}

/** Issue a fresh asset from `issuer`, deploy its SAC, and return the SAC's contract id. */
export async function deployTestToken(issuer: Keypair, code: string): Promise<string> {
    const asset = new Asset(code, issuer.publicKey());
    await submitPlain(issuer, Operation.createStellarAssetContract({ asset }));
    return asset.contractId(NETWORK_PASSPHRASE);
}

export function nativeTokenId(): string {
    return Asset.native().contractId(NETWORK_PASSPHRASE);
}

export async function sacMint(issuer: Keypair, tokenId: string, to: string, amount: bigint) {
    return submitPlain(
        issuer,
        new Contract(tokenId).call('mint', new Address(to).toScVal(), nativeToScVal(amount, { type: 'i128' })),
    );
}

export async function sacTransferFromAccount(from: Keypair, tokenId: string, to: string, amount: bigint) {
    return submitPlain(
        from,
        new Contract(tokenId).call(
            'transfer',
            new Address(from.publicKey()).toScVal(),
            new Address(to).toScVal(),
            nativeToScVal(amount, { type: 'i128' }),
        ),
    );
}

export async function balanceOf(tokenId: string, holder: string): Promise<bigint> {
    return BigInt((await simulateRead(tokenId, 'balance', [new Address(holder).toScVal()])) as bigint);
}

/** The ledger's own clock, in unix seconds. */
export async function ledgerTime(): Promise<bigint> {
    const latest = await server._getLatestLedger();
    return BigInt(latest.closeTime);
}

export async function waitForLedgerTime(target: bigint): Promise<void> {
    while ((await ledgerTime()) <= target) {
        await new Promise((r) => setTimeout(r, 2000));
    }
}

