import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Account, Asset, Contract, Keypair, rpc as SorobanRpc, Horizon, TransactionBuilder, BASE_FEE, xdr, nativeToScVal, scValToNative, Networks, hash as stellarHash, } from '@stellar/stellar-sdk';
const HorizonServer = Horizon.Server;
import { bufferToHex, hexToUint8Array, computeWalletAddress, } from './utils';
import { webAuthnProvider } from './webauthn';
import { TransactionOutbox } from './outbox';
import { verifyAttestation, AttestationError } from './webauthn/attestation';
import { createLocalCipher } from './crypto/prf';
import { deriveCounterfactualAddress as _deriveCounterfactualAddress } from './counterfactual';
// ── Recovery Errors ───────────────────────────────────────────────────────────
/** Thrown when completeRecovery() is called before the timelock has expired. */
export class RecoveryTimelockActive extends Error {
    constructor(unlockTime) {
        super(`Recovery timelock active until ${unlockTime}`);
        this.unlockTime = unlockTime;
        this.name = 'RecoveryTimelockActive';
    }
}
/** Thrown when recovery methods are called but no guardian has been set. */
export class NoGuardianSet extends Error {
    constructor() {
        super('No guardian set on this wallet');
        this.name = 'NoGuardianSet';
    }
}
/** Thrown when completeRecovery() is called but no recovery is in progress. */
export class RecoveryNotPending extends Error {
    constructor() {
        super('No recovery is currently pending');
        this.name = 'RecoveryNotPending';
    }
}
// ── Helpers ───────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 1000;
const POLL_MAX_ATTEMPTS = 30;
/** Storage key holding the roaming (cross-platform) credential as a portable signer. */
const PORTABLE_SIGNER_KEY = 'invisible_wallet_portable_signer';
/**
 * Poll server.getTransaction(hash) until the transaction leaves NOT_FOUND,
 * then return the final result. Throws if it fails or we exceed the attempt limit.
 */
async function waitForTransaction(server, hash) {
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        const result = await server.getTransaction(hash);
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
            return result;
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Transaction ${hash} not confirmed after ${POLL_MAX_ATTEMPTS} attempts`);
}
function resolveSponsorKeypair(config) {
    return config.sponsorSecret ? Keypair.fromSecret(config.sponsorSecret) : null;
}
function signForSubmission(tx, signerKeypair, config, extraInnerSigners = []) {
    tx.sign(signerKeypair);
    for (const extraSigner of extraInnerSigners) {
        if (extraSigner.publicKey() !== signerKeypair.publicKey()) {
            tx.sign(extraSigner);
        }
    }
    const sponsor = resolveSponsorKeypair(config);
    if (!sponsor)
        return tx;
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(sponsor.publicKey(), config.feeBumpBaseFee ?? BASE_FEE, tx, config.networkPassphrase);
    feeBump.sign(sponsor);
    return feeBump;
}
/** Build a storage adapter from the config, defaulting to localStorage on web. */
function resolveStorage(storage) {
    if (storage)
        return storage;
    if (typeof localStorage !== 'undefined') {
        return {
            getItem: (k) => localStorage.getItem(k),
            setItem: (k, v) => localStorage.setItem(k, v),
            removeItem: (k) => localStorage.removeItem(k),
        };
    }
    return { getItem: () => null, setItem: () => { }, removeItem: () => { } };
}
/** Read and parse the persisted portable-signer record, or null if none/invalid. */
async function readPortableSigner(store) {
    const raw = await store.getItem(PORTABLE_SIGNER_KEY);
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.authenticatorAttachment === 'cross-platform' && parsed.credentialId) {
            return { ...parsed, transports: parsed.transports ?? [] };
        }
        return null;
    }
    catch {
        return null;
    }
}
// ── Hook ──────────────────────────────────────────────────────────────────────
export function useInvisibleWallet(config) {
    const { factoryAddress, rpcUrl, networkPassphrase, rpId, origin } = config;
    const [address, setAddress] = useState(null);
    const [isDeployed, setIsDeployed] = useState(false);
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState(null);
    const store = useMemo(() => resolveStorage(config.storage), [config.storage]);
    const outbox = useMemo(() => new TransactionOutbox(store), [store]);
    // Cache the PRF-derived cipher so the interactive assertion runs at most once
    // per session. Reset whenever the storage adapter changes (i.e. a new wallet).
    const cipherRef = useRef(null);
    useEffect(() => { cipherRef.current = null; }, [store]);
    // ── replayOutbox ────────────────────────────────────────────────────────
    // Resubmit any transactions persisted in the offline outbox. Deduped by
    // hash so repeated calls (and the reconnect listener below) are safe.
    const replayOutbox = useCallback(async (opts) => {
        const server = new SorobanRpc.Server(rpcUrl);
        return outbox.replay(server, opts);
    }, [rpcUrl, outbox]);
    // Auto-replay when connectivity returns. No-op outside the browser.
    useEffect(() => {
        if (config.autoReplayOnReconnect === false)
            return;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function')
            return;
        const onOnline = () => { void replayOutbox().catch(() => { }); };
        window.addEventListener('online', onOnline);
        return () => window.removeEventListener('online', onOnline);
    }, [config.autoReplayOnReconnect, replayOutbox]);
    useEffect(() => {
        // Support both synchronous (localStorage) and asynchronous (AsyncStorage) adapters.
        // The synchronous branch keeps the existing test behaviour unchanged.
        const maybeStored = store.getItem('invisible_wallet_address');
        if (maybeStored && typeof maybeStored.then === 'function') {
            maybeStored.then((v) => { if (v)
                setAddress(v); });
        }
        else {
            const stored = maybeStored;
            if (stored)
                setAddress(stored);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // ── register ──────────────────────────────────────────────────────────────
    const register = useCallback(async (username, options) => {
        setIsPending(true);
        setError(null);
        try {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const normalizedUsername = username ? username.normalize('NFC') : undefined;
            const name = normalizedUsername || 'Veil User';
            const userId = normalizedUsername
                ? new TextEncoder().encode(normalizedUsername)
                : crypto.getRandomValues(new Uint8Array(16));
            const resolvedRpId = rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
            const { credentialId, publicKeyBytes, attestationObject, clientDataJSON, authenticatorAttachment, transports } = await webAuthnProvider.create({
                challenge,
                rpId: resolvedRpId,
                rpName: 'Invisible Wallet',
                userId,
                userName: name,
                authenticatorAttachment: options?.authenticatorAttachment,
            });
            // Optional attestation verification — enforce authenticator policy.
            if (config.attestationPolicy) {
                if (attestationObject && clientDataJSON) {
                    await verifyAttestation({
                        attestationObject,
                        clientDataJSON,
                        policy: config.attestationPolicy,
                    });
                }
                else if (config.requireAttestation) {
                    throw new AttestationError('Attestation required but the platform did not expose an attestationObject.');
                }
            }
            const publicKeyHex = bufferToHex(publicKeyBytes);
            const walletAddress = computeWalletAddress(factoryAddress, publicKeyBytes, networkPassphrase);
            // Treat the credential as a portable signer when either the caller asked
            // for a roaming key or the platform reported a cross-platform attachment.
            const resolvedAttachment = authenticatorAttachment ?? options?.authenticatorAttachment;
            const isPortableSigner = resolvedAttachment === 'cross-platform';
            await store.setItem('invisible_wallet_address', walletAddress);
            await store.setItem('invisible_wallet_key_id', credentialId);
            await store.setItem('invisible_wallet_public_key', publicKeyHex);
            if (isPortableSigner) {
                // Persist the roaming credential under its own key so it is stored and
                // identified independently of platform passkeys, and so signAuthEntry
                // can replay its transports when signing from another device.
                const portable = {
                    credentialId,
                    publicKey: publicKeyHex,
                    authenticatorAttachment: 'cross-platform',
                    transports: transports ?? [],
                };
                await store.setItem(PORTABLE_SIGNER_KEY, JSON.stringify(portable));
            }
            else if (store.removeItem) {
                // Clear any stale portable-signer record from a previous roaming enrolment.
                await store.removeItem(PORTABLE_SIGNER_KEY);
            }
            setAddress(walletAddress);
            setIsDeployed(false);
            return { walletAddress, publicKeyBytes, authenticatorAttachment: resolvedAttachment, isPortableSigner };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [factoryAddress, networkPassphrase, rpId, store, config.attestationPolicy, config.requireAttestation]);
    // ── deriveCounterfactualAddress ───────────────────────────────────────────
    const deriveCounterfactualAddress = useCallback((publicKeyBytes) => {
        return _deriveCounterfactualAddress(publicKeyBytes, { factoryAddress, networkPassphrase });
    }, [factoryAddress, networkPassphrase]);
    // ── getPortableSigner ───────────────────────────────────────────────────────
    const getPortableSigner = useCallback(async () => {
        return readPortableSigner(store);
    }, [store]);
    // ── deploy ────────────────────────────────────────────────────────────────
    const deploy = useCallback(async (signerSecret, publicKeyBytes) => {
        const signerKeypair = typeof signerSecret === 'string'
            ? Keypair.fromSecret(signerSecret)
            : Keypair.fromSecret(signerSecret.secret());
        setIsPending(true);
        setError(null);
        let walletAddress;
        try {
            let pubKeyBytes = publicKeyBytes;
            if (!pubKeyBytes) {
                const hex = await store.getItem('invisible_wallet_public_key');
                if (!hex)
                    throw new Error('No public key found. Call register() first, or pass publicKeyBytes explicitly.');
                pubKeyBytes = hexToUint8Array(hex);
            }
            walletAddress = computeWalletAddress(factoryAddress, pubKeyBytes, networkPassphrase);
            const server = new SorobanRpc.Server(rpcUrl);
            const horizonUrl = networkPassphrase === Networks.TESTNET
                ? 'https://horizon-testnet.stellar.org'
                : 'https://horizon.stellar.org';
            const horizon = new HorizonServer(horizonUrl);
            const sourceAccount = await horizon.loadAccount(signerKeypair.publicKey());
            const factory = new Contract(factoryAddress);
            const resolvedRpId = rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
            const resolvedOrigin = origin ?? (typeof window !== 'undefined' ? window.location.origin : `https://${resolvedRpId}`);
            const rpIdBytes = new TextEncoder().encode(resolvedRpId);
            const originBytes = new TextEncoder().encode(resolvedOrigin);
            const txBuilder = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            });
            txBuilder.addOperation(factory.call('deploy', nativeToScVal(pubKeyBytes, { type: 'bytes' }), nativeToScVal(rpIdBytes, { type: 'bytes' }), nativeToScVal(originBytes, { type: 'bytes' })));
            const tx = txBuilder.setTimeout(30).build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }
            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, signerKeypair, config);
            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
            }
            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }
            setAddress(walletAddress);
            setIsDeployed(true);
            await store.setItem('invisible_wallet_address', walletAddress);
            return { walletAddress, alreadyDeployed: false };
        }
        catch (err) {
            let message;
            if (err instanceof Error) {
                message = err.message;
            }
            else {
                try {
                    message = JSON.stringify(err);
                }
                catch {
                    message = String(err);
                }
            }
            if (message.toLowerCase().includes('alreadydeployed') || message.toLowerCase().includes('already_deployed')) {
                setAddress(walletAddress);
                setIsDeployed(true);
                await store.setItem('invisible_wallet_address', walletAddress);
                return { walletAddress: walletAddress, alreadyDeployed: true };
            }
            setError(message);
            throw new Error(message);
        }
        finally {
            setIsPending(false);
        }
    }, [factoryAddress, rpcUrl, networkPassphrase, rpId, origin, store, config]);
    // ── login ─────────────────────────────────────────────────────────────────
    const login = useCallback(async () => {
        setIsPending(true);
        setError(null);
        try {
            const stored = await store.getItem('invisible_wallet_address');
            if (!stored) {
                setError('No wallet found. Please register first.');
                return null;
            }
            const server = new SorobanRpc.Server(rpcUrl);
            try {
                await server.getContractData(stored, xdr.ScVal.scvLedgerKeyContractInstance(), SorobanRpc.Durability.Persistent);
                setAddress(stored);
                setIsDeployed(true);
                return { walletAddress: stored };
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.toLowerCase().includes('not found')) {
                    setError('Wallet not yet deployed. Call deploy() to create it on-chain.');
                    setAddress(null);
                    setIsDeployed(false);
                    return null;
                }
                else {
                    throw e;
                }
            }
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            return null;
        }
        finally {
            setIsPending(false);
        }
    }, [rpcUrl, store]);
    // ── signAuthEntry ─────────────────────────────────────────────────────────
    const signAuthEntry = useCallback(async (signaturePayload) => {
        setIsPending(true);
        setError(null);
        try {
            const keyId = await store.getItem('invisible_wallet_key_id');
            const publicKeyHex = await store.getItem('invisible_wallet_public_key');
            if (!keyId)
                throw new Error('No key ID found. Please register first.');
            if (!publicKeyHex)
                throw new Error('No public key found. Please register first.');
            if (signaturePayload.length !== 32) {
                throw new Error('signaturePayload must be exactly 32 bytes');
            }
            const challenge = signaturePayload.buffer.slice(signaturePayload.byteOffset, signaturePayload.byteOffset + signaturePayload.byteLength);
            // For a roaming key, forward the stored transports so the assertion can
            // prompt for the security key over USB/NFC/BLE on any device.
            const portable = await readPortableSigner(store);
            const { authData, clientDataJSON, signature } = await webAuthnProvider.authenticate({
                challenge,
                credentialId: keyId,
                rpId,
                transports: portable?.transports,
            });
            const publicKeyBytes = hexToUint8Array(publicKeyHex);
            return { publicKey: publicKeyBytes, authData, clientDataJSON, signature };
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [rpId, store]);
    // ── getNonce ──────────────────────────────────────────────────────────────
    const getNonce = useCallback(async () => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('get_nonce'))
                .setTimeout(30)
                .build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }
            const result = sim.result;
            if (!result)
                throw new Error('Simulation returned no result');
            const nonce = scValToNative(result.retval);
            return nonce;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);
    // ── addSigner ─────────────────────────────────────────────────────────────
    const addSigner = useCallback(async (signerKeypair, newPublicKeyBytes) => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            if (newPublicKeyBytes.length !== 65) {
                throw new Error('newPublicKeyBytes must be exactly 65 bytes (uncompressed P-256)');
            }
            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('add_signer', nativeToScVal(newPublicKeyBytes, { type: 'bytes' })))
                .setTimeout(30)
                .build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }
            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, signerKeypair, config);
            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
            }
            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }
            let signerIndex = 0;
            if ('returnValue' in txResult && txResult.returnValue) {
                try {
                    signerIndex = scValToNative(txResult.returnValue);
                }
                catch {
                    // Contract may not return an index — default to 0
                }
            }
            return { signerIndex };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase, config]);
    // ── getSigners ────────────────────────────────────────────────────────────
    const getSigners = useCallback(async () => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('get_signers'))
                .setTimeout(30)
                .build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }
            const result = sim.result;
            if (!result)
                throw new Error('Simulation returned no result');
            const signersData = scValToNative(result.retval);
            const infos = [];
            const entries = signersData instanceof Map
                ? signersData.entries()
                : Object.entries(signersData);
            for (const [index, key] of entries) {
                infos.push({
                    index: typeof index === 'string' ? parseInt(index, 10) : index,
                    publicKey: bufferToHex(key),
                });
            }
            return infos.sort((a, b) => a.index - b.index);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);
    // ── removeSigner ──────────────────────────────────────────────────────────
    const removeSigner = useCallback(async (signerKeypair, signerIndex) => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('remove_signer', nativeToScVal(signerIndex, { type: 'u32' })))
                .setTimeout(30)
                .build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }
            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, signerKeypair, config);
            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
            }
            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase, config]);
    // ── setGuardian ───────────────────────────────────────────────────────────
    const setGuardian = useCallback(async (signerKeypair, guardianAddress) => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('set_guardian', nativeToScVal(guardianAddress, { type: 'address' })))
                .setTimeout(30)
                .build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }
            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const successSim = sim;
            const authEntries = successSim.result?.auth;
            if (authEntries) {
                // stellarHash is a synchronous SHA-256 — avoids crypto.subtle (unavailable on some RN setups)
                const networkIdBytes = new Uint8Array(stellarHash(Buffer.from(networkPassphrase)));
                for (const parsed of authEntries) {
                    const cred = parsed.credentials();
                    if (cred.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
                        continue;
                    }
                    const addrCred = cred.address();
                    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
                        networkId: Buffer.from(networkIdBytes),
                        nonce: addrCred.nonce(),
                        invocation: parsed.rootInvocation(),
                        signatureExpirationLedger: addrCred.signatureExpirationLedger(),
                    }));
                    const payloadHash = new Uint8Array(stellarHash(Buffer.from(preimage.toXDR())));
                    const webAuthnSig = await signAuthEntry(payloadHash);
                    if (!webAuthnSig)
                        throw new Error('WebAuthn signing was cancelled');
                    const sigVec = xdr.ScVal.scvVec([
                        nativeToScVal(webAuthnSig.publicKey, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.authData, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.signature, { type: 'bytes' }),
                    ]);
                    parsed.credentials(xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
                        address: addrCred.address(),
                        nonce: addrCred.nonce(),
                        signatureExpirationLedger: addrCred.signatureExpirationLedger(),
                        signature: sigVec,
                    })));
                }
            }
            const submissionTx = signForSubmission(assembled, signerKeypair, config);
            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
            }
            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase, signAuthEntry, config]);
    // ── initiateRecovery ──────────────────────────────────────────────────────
    const initiateRecovery = useCallback(async (guardianKeypair, newPublicKeyBytes) => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            if (newPublicKeyBytes.length !== 65) {
                throw new Error('newPublicKeyBytes must be exactly 65 bytes (uncompressed P-256)');
            }
            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(guardianKeypair.publicKey());
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('initiate_recovery', nativeToScVal(newPublicKeyBytes, { type: 'bytes' })))
                .setTimeout(30)
                .build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                const errMsg = sim.error ?? '';
                if (errMsg.includes('NoGuardianSet') || errMsg.includes('no guardian')) {
                    throw new NoGuardianSet();
                }
                throw new Error(`Simulation failed: ${errMsg}`);
            }
            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, guardianKeypair, config);
            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
            }
            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }
            let unlockTime = 0;
            if ('returnValue' in txResult && txResult.returnValue) {
                try {
                    unlockTime = Number(scValToNative(txResult.returnValue));
                }
                catch {
                    // Default to 0 if parsing fails
                }
            }
            return { unlockTime };
        }
        catch (err) {
            if (err instanceof NoGuardianSet)
                throw err;
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase, config]);
    // ── completeRecovery ──────────────────────────────────────────────────────
    const completeRecovery = useCallback(async (payerKeypair) => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(payerKeypair.publicKey());
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('complete_recovery'))
                .setTimeout(30)
                .build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                const errMsg = sim.error ?? '';
                if (errMsg.includes('TimelockActive') || errMsg.includes('timelock')) {
                    const match = errMsg.match(/(\d{10,})/);
                    const unlockTime = match ? Number(match[1]) : 0;
                    throw new RecoveryTimelockActive(unlockTime);
                }
                if (errMsg.includes('NoGuardianSet') || errMsg.includes('no guardian')) {
                    throw new NoGuardianSet();
                }
                if (errMsg.includes('NotPending') || errMsg.includes('not pending')) {
                    throw new RecoveryNotPending();
                }
                throw new Error(`Simulation failed: ${errMsg}`);
            }
            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, payerKeypair, config);
            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
            }
            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }
        }
        catch (err) {
            if (err instanceof RecoveryTimelockActive ||
                err instanceof NoGuardianSet ||
                err instanceof RecoveryNotPending) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);
    // ── getBalance ──────────────────────────────────────────────────────────
    const getBalance = useCallback(async (token) => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(rpcUrl);
            const contractAddress = token ?? Asset.native().contractId(networkPassphrase);
            const tokenContract = new Contract(contractAddress);
            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(tokenContract.call('balance', nativeToScVal(address, { type: 'address' })))
                .setTimeout(30)
                .build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }
            const result = sim.result;
            if (!result || result.retval === undefined)
                throw new Error('Simulation returned no result');
            const amount = scValToNative(result.retval);
            return {
                address,
                amount,
                assetCode: token ? token : 'XLM',
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, networkPassphrase, rpcUrl]);
    // ── sendPayment ──────────────────────────────────────────────────────────
    const sendPayment = useCallback(async (signerKeypair, to, amount, token, memo) => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            const payerKeypair = typeof signerKeypair === 'string'
                ? Keypair.fromSecret(signerKeypair)
                : signerKeypair;
            const contractAddress = token ?? Asset.native().contractId(networkPassphrase);
            const tokenContract = new Contract(contractAddress);
            const amountValue = typeof amount === 'bigint'
                ? amount
                : BigInt(Math.round(amount));
            const server = new SorobanRpc.Server(rpcUrl);
            const sourceAccount = await server.getAccount(payerKeypair.publicKey());
            const txBuilder = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(tokenContract.call('transfer', nativeToScVal(address, { type: 'address' }), nativeToScVal(to, { type: 'address' }), nativeToScVal(amountValue, { type: 'i128' })));
            if (memo !== undefined) {
                txBuilder.addMemo({ type: 'text', value: String(memo) });
            }
            const tx = txBuilder.setTimeout(30).build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }
            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const successSim = sim;
            const authEntries = successSim.result?.auth;
            if (authEntries) {
                const networkIdBytes = new Uint8Array(stellarHash(Buffer.from(networkPassphrase)));
                for (const parsed of authEntries) {
                    const cred = parsed.credentials();
                    if (cred.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
                        continue;
                    }
                    const addrCred = cred.address();
                    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
                        networkId: Buffer.from(networkIdBytes),
                        nonce: addrCred.nonce(),
                        invocation: parsed.rootInvocation(),
                        signatureExpirationLedger: addrCred.signatureExpirationLedger(),
                    }));
                    const payloadHash = new Uint8Array(stellarHash(Buffer.from(preimage.toXDR())));
                    const webAuthnSig = await signAuthEntry(payloadHash);
                    if (!webAuthnSig)
                        throw new Error('WebAuthn signing was cancelled');
                    const sigVec = xdr.ScVal.scvVec([
                        nativeToScVal(webAuthnSig.publicKey, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.authData, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.signature, { type: 'bytes' }),
                    ]);
                    parsed.credentials(xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
                        address: addrCred.address(),
                        nonce: addrCred.nonce(),
                        signatureExpirationLedger: addrCred.signatureExpirationLedger(),
                        signature: sigVec,
                    })));
                }
            }
            const submissionTx = signForSubmission(assembled, payerKeypair, config);
            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
            }
            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }
            return { transactionHash: sendResult.hash, status: 'SUCCESS' };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, networkPassphrase, rpcUrl, signAuthEntry, config]);
    // ── getAllowance ──────────────────────────────────────────────────────────
    const getAllowance = useCallback(async (spender, token) => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('get_allowance', nativeToScVal(spender, { type: 'address' }), nativeToScVal(token, { type: 'address' })))
                .setTimeout(30)
                .build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }
            const result = sim.result;
            if (!result || !result.retval)
                throw new Error('Simulation returned no result');
            if (result.retval.switch() === xdr.ScValType.scvVoid()) {
                return null;
            }
            const allowanceMap = scValToNative(result.retval);
            return {
                amount: Number(allowanceMap.amount),
                expiry: allowanceMap.expiry !== undefined ? Number(allowanceMap.expiry) : undefined,
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);
    // ── approve ───────────────────────────────────────────────────────────────
    const approve = useCallback(async (signerKeypair, spender, token, amount, expiry) => {
        setIsPending(true);
        setError(null);
        try {
            if (!address)
                throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());
            let expiryVal;
            if (expiry !== undefined) {
                expiryVal = nativeToScVal([nativeToScVal(BigInt(expiry), { type: 'u64' })], { type: 'Vec' });
            }
            else {
                expiryVal = xdr.ScVal.scvVoid();
            }
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('approve', nativeToScVal(spender, { type: 'address' }), nativeToScVal(token, { type: 'address' }), nativeToScVal(BigInt(amount), { type: 'i128' }), expiryVal))
                .setTimeout(30)
                .build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }
            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const successSim = sim;
            const authEntries = successSim.result?.auth;
            if (authEntries) {
                const networkIdBytes = new Uint8Array(stellarHash(Buffer.from(networkPassphrase)));
                for (const parsed of authEntries) {
                    const cred = parsed.credentials();
                    if (cred.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
                        continue;
                    }
                    const addrCred = cred.address();
                    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
                        networkId: Buffer.from(networkIdBytes),
                        nonce: addrCred.nonce(),
                        invocation: parsed.rootInvocation(),
                        signatureExpirationLedger: addrCred.signatureExpirationLedger(),
                    }));
                    const payloadHash = new Uint8Array(stellarHash(Buffer.from(preimage.toXDR())));
                    const webAuthnSig = await signAuthEntry(payloadHash);
                    if (!webAuthnSig)
                        throw new Error('WebAuthn signing was cancelled');
                    const sigVec = xdr.ScVal.scvVec([
                        nativeToScVal(webAuthnSig.publicKey, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.authData, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.signature, { type: 'bytes' }),
                    ]);
                    parsed.credentials(xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
                        address: addrCred.address(),
                        nonce: addrCred.nonce(),
                        signatureExpirationLedger: addrCred.signatureExpirationLedger(),
                        signature: sigVec,
                    })));
                }
            }
            const submissionTx = signForSubmission(assembled, signerKeypair, config);
            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
            }
            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        }
        finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase, signAuthEntry, config]);
    // ── Local PRF-derived encryption ──────────────────────────────────────────
    // Lazily derive (and cache) a passkey-bound cipher for the registered
    // credential, falling back to a stored random key when PRF is unsupported.
    const getCipher = useCallback(async () => {
        if (cipherRef.current)
            return cipherRef.current;
        const credentialId = await store.getItem('invisible_wallet_key_id');
        if (!credentialId)
            throw new Error('No passkey credential found. Please register first.');
        const cipher = await createLocalCipher({ credentialId, rpId, storage: store });
        cipherRef.current = cipher;
        return cipher;
    }, [rpId, store]);
    const encryptLocal = useCallback(async (plaintext) => {
        const cipher = await getCipher();
        return cipher.encrypt(plaintext);
    }, [getCipher]);
    const decryptLocal = useCallback(async (payload) => {
        const cipher = await getCipher();
        return cipher.decryptString(payload);
    }, [getCipher]);
    const encryptionMode = useCallback(async () => {
        const cipher = await getCipher();
        return cipher.mode;
    }, [getCipher]);
    return useMemo(() => ({ address, isDeployed, isPending, error, register, deploy, signAuthEntry, deriveCounterfactualAddress, getPortableSigner, login, getNonce, addSigner, removeSigner, getSigners, setGuardian, initiateRecovery, completeRecovery, approve, getAllowance, getBalance, sendPayment, outbox, replayOutbox, encryptLocal, decryptLocal, encryptionMode }), [address, isDeployed, isPending, error, register, deploy, signAuthEntry, deriveCounterfactualAddress, getPortableSigner, login, getNonce, addSigner, removeSigner, getSigners, setGuardian, initiateRecovery, completeRecovery, approve, getAllowance, getBalance, sendPayment, outbox, replayOutbox, encryptLocal, decryptLocal, encryptionMode]);
}
