"use client";

import React, { useState } from 'react';
import { useInvisibleWallet, WebAuthnSignature } from 'invisible-wallet-sdk';
import { rpc, Keypair, Contract, xdr, TransactionBuilder, Networks } from 'stellar-sdk';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';
import { Buffer } from 'buffer';

const FACTORY_ADDRESS = process.env.NEXT_PUBLIC_FACTORY_ADDRESS || '';
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;

type SignerInfo = {
    publicKeyHex: string;
    spendLimit: string | null;
};

export default function Home() {
    const { address, isPending, error, register, signAuthEntry } = useInvisibleWallet(FACTORY_ADDRESS);
    
    const [username, setUsername] = useState('');
    const [localError, setLocalError] = useState<string | null>(null);
    const [deployHash, setDeployHash] = useState<string | null>(null);
    const [deploying, setDeploying] = useState(false);
    const [signatureResult, setSignatureResult] = useState<WebAuthnSignature | null>(null);
    const [signing, setSigning] = useState(false);

    const [signers, setSigners] = useState<SignerInfo[]>([]);
    const [loadingSigners, setLoadingSigners] = useState(false);
    const [newSignerHex, setNewSignerHex] = useState('');
    const [newSpendLimit, setNewSpendLimit] = useState('');
    const [signerBusy, setSignerBusy] = useState(false);
    const [signerMessage, setSignerMessage] = useState<string | null>(null);

    // 1. Register Action
    const handleRegister = async () => {
        try {
            setLocalError(null);
            await register(username || 'testuser');
        } catch (err: any) {
            setLocalError(err.message || String(err));
        }
    };

    // 2. Deploy Action
    const handleDeploy = async () => {
        setDeploying(true);
        setLocalError(null);
        setDeployHash(null);
        try {
            // Get the saved public key from localStorage (saved by register)
            const pubKeyHex = localStorage.getItem('invisible_wallet_public_key');
            if (!pubKeyHex) throw new Error("No public key found. Please register first.");

            const feePayer = Keypair.random();
            const server = new rpc.Server(RPC_URL, { allowHttp: true });

            // Fund the new fee-payer account via Friendbot
            const friendbotResp = await fetch(`https://friendbot.stellar.org?addr=${feePayer.publicKey()}`);
            if (!friendbotResp.ok) {
                throw new Error("Failed to fund fee payer account via Friendbot.");
            }

            const account = await server.getAccount(feePayer.publicKey());
            const contract = new Contract(FACTORY_ADDRESS);

            // Convert Hex to Buffer for xdr (requires Buffer from 'buffer')
            const pubKeyBytes = Buffer.from(pubKeyHex, 'hex');
            const pubKeyVal = xdr.ScVal.scvBytes(pubKeyBytes);

            let tx = new TransactionBuilder(account, { 
                fee: '100000', 
                networkPassphrase: NETWORK_PASSPHRASE 
            })
            .addOperation(contract.call("deploy", pubKeyVal))
            .setTimeout(30)
            .build();

            // Simulate
            const simReq = await server.simulateTransaction(tx);
            if (rpc.Api.isSimulationError(simReq)) {
                throw new Error(`Simulation failed: ${(simReq as any).error || JSON.stringify(simReq)}`);
            }

            // Assemble
            const assembledTx = await server.prepareTransaction(tx);
            assembledTx.sign(feePayer);

            // Submit
            const submitReq = await server.sendTransaction(assembledTx);
            if (submitReq.errorResult) {
                throw new Error(`Submission failed: ${submitReq.errorResult}`);
            }

            // Poll for inclusion
            let attempts = 0;
            let successHash = null;
            while (attempts < 15) {
                const txResp = await server.getTransaction(submitReq.hash);
                if (txResp.status === "SUCCESS") {
                    successHash = submitReq.hash;
                    break;
                } else if (txResp.status === "FAILED") {
                    throw new Error("Transaction failed on-chain");
                }
                await new Promise(r => setTimeout(r, 2000));
                attempts++;
            }

            if (!successHash) throw new Error("Transaction timed out");
            
            setDeployHash(successHash);
            
        } catch (err: any) {
            setLocalError(err.message || String(err));
        } finally {
            setDeploying(false);
        }
    };

    // 3. Sign Action
    const handleSign = async () => {
        setSigning(true);
        setLocalError(null);
        setSignatureResult(null);
        try {
            // Create a hardcoded 32-byte test payload
            const testPayload = new Uint8Array(32);
            testPayload.fill(7); // Random data

            const sig = await signAuthEntry(testPayload);
            if (!sig) throw new Error("Signature returned null or was cancelled.");
            
            setSignatureResult(sig);
        } catch (err: any) {
            setLocalError(err.message || String(err));
        } finally {
            setSigning(false);
        }
    };

    // 4. Signer management
    const loadSigners = async () => {
        if (!address) return;
        setLoadingSigners(true);
        setSignerMessage(null);
        try {
            const server = new rpc.Server(RPC_URL, { allowHttp: true });
            const contract = new Contract(address);
            const sourceKp = Keypair.random();
            await fetch(`https://friendbot.stellar.org?addr=${sourceKp.publicKey()}`);
            const account = await server.getAccount(sourceKp.publicKey());
            const tx = new TransactionBuilder(account, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
                .addOperation(contract.call("get_signers"))
                .setTimeout(30)
                .build();
            const sim: any = await server.simulateTransaction(tx);
            if (rpc.Api.isSimulationError(sim)) {
                throw new Error(`Failed to load signers: ${sim.error || JSON.stringify(sim)}`);
            }
            const retval = sim.result?.retval;
            const parsed: SignerInfo[] = [];
            if (retval) {
                const entries = retval.vec() || [];
                for (const entry of entries) {
                    const map = entry.map() || [];
                    let publicKeyHex = '';
                    let spendLimit: string | null = null;
                    for (const kv of map) {
                        const key = kv.key().sym().toString();
                        const val = kv.val();
                        if (key === 'public_key') {
                            publicKeyHex = Buffer.from(val.bytes()).toString('hex');
                        } else if (key === 'spend_limit') {
                            const opt = val.switch().name === 'scvVoid' ? null : val;
                            spendLimit = opt ? (opt.i128 ? String(opt.i128().lo().toString()) : null) : null;
                        }
                    }
                    parsed.push({ publicKeyHex, spendLimit });
                }
            }
            setSigners(parsed);
        } catch (err: any) {
            setSignerMessage(err.message || String(err));
        } finally {
            setLoadingSigners(false);
        }
    };

    const removeSigner = async (publicKeyHex: string) => {
        if (signers.length <= 1) {
            setSignerMessage('Cannot remove the last signer: a wallet must always have at least one signing key.');
            return;
        }
        if (!address) return;
        setSignerBusy(true);
        setSignerMessage(null);
        try {
            const contract = new Contract(address);
            const pubKeyVal = xdr.ScVal.scvBytes(Buffer.from(publicKeyHex, 'hex'));
            await submitWalletCall(contract.call("remove_signer", pubKeyVal));
            setSignerMessage('Signer removed. It can no longer sign.');
            await loadSigners();
        } catch (err: any) {
            setSignerMessage(err.message || String(err));
        } finally {
            setSignerBusy(false);
        }
    };

    const addSigner = async () => {
        if (!address) return;
        const hex = newSignerHex.trim();
        if (!/^[0-9a-fA-F]{130}$/.test(hex)) {
            setSignerMessage('Signer public key must be 65 bytes (130 hex characters).');
            return;
        }
        setSignerBusy(true);
        setSignerMessage(null);
        try {
            const contract = new Contract(address);
            const args: xdr.ScVal[] = [xdr.ScVal.scvBytes(Buffer.from(hex, 'hex'))];
            const limit = newSpendLimit.trim();
            if (limit) {
                args.push(xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString(limit) })));
            } else {
                args.push(xdr.ScVal.scvVoid());
            }
            await submitWalletCall(contract.call("add_signer", ...args));
            setNewSignerHex('');
            setNewSpendLimit('');
            setSignerMessage('Signer added.');
            await loadSigners();
        } catch (err: any) {
            setSignerMessage(err.message || String(err));
        } finally {
            setSignerBusy(false);
        }
    };

    const submitWalletCall = async (op: xdr.Operation) => {
        const server = new rpc.Server(RPC_URL, { allowHttp: true });
        const feePayer = Keypair.random();
        await fetch(`https://friendbot.stellar.org?addr=${feePayer.publicKey()}`);
        const account = await server.getAccount(feePayer.publicKey());
        const tx = new TransactionBuilder(account, { fee: '100000', networkPassphrase: NETWORK_PASSPHRASE })
            .addOperation(op)
            .setTimeout(30)
            .build();
        const sim: any = await server.simulateTransaction(tx);
        if (rpc.Api.isSimulationError(sim)) {
            throw new Error(`Simulation failed: ${sim.error || JSON.stringify(sim)}`);
        }
        const assembled = await server.prepareTransaction(tx);
        assembled.sign(feePayer);
        const submit = await server.sendTransaction(assembled);
        if (submit.errorResult) {
            throw new Error(`Submission failed: ${submit.errorResult}`);
        }
        for (let i = 0; i < 15; i++) {
            const resp = await server.getTransaction(submit.hash);
            if (resp.status === 'SUCCESS') return submit.hash;
            if (resp.status === 'FAILED') throw new Error('Transaction failed on-chain');
            await new Promise(r => setTimeout(r, 2000));
        }
        throw new Error('Transaction timed out');
    };

    // Helper func
    const toHex = (bytes: Uint8Array) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

    return (
        <main className="min-h-screen p-8 max-w-2xl mx-auto space-y-8 font-sans text-gray-800">
            <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-purple-600">
                Veil Passkey Wallet Demo
            </h1>
            
            {(error || localError) && (
                <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-lg flex items-start gap-3">
                    <XCircle className="w-5 h-5 mt-0.5 shrink-0" />
                    <span className="text-sm">{error || localError}</span>
                </div>
            )}

            {/* REGISTER SECTION */}
            <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <h2 className="text-xl font-semibold mb-4">1. Register</h2>
                <div className="flex gap-4 mb-4">
                    <input 
                        type="text" 
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Enter username"
                        className="border border-gray-300 rounded px-3 py-2 text-sm flex-1 outline-none focus:border-blue-500 transition-colors"
                    />
                    <button 
                        onClick={handleRegister}
                        disabled={isPending}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded font-medium disabled:opacity-50 flex items-center gap-2 transition-colors"
                    >
                        {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                        Register
                    </button>
                </div>
                {address && (
                    <div className="bg-blue-50 p-4 rounded-lg border border-blue-100 text-sm">
                        <span className="font-semibold text-blue-900 block mb-1">Computed Wallet Address:</span>
                        <code className="text-blue-800 break-all">{address}</code>
                    </div>
                )}
            </section>

            {/* DEPLOY SECTION */}
            <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <h2 className="text-xl font-semibold mb-4">2. Deploy to Testnet</h2>
                <div className="mb-4 text-sm text-gray-600">
                    This step generates a random Stellar Keypair, funds it with Friendbot, and uses it to submit the factory deployment transaction.
                </div>
                <button 
                    onClick={handleDeploy}
                    disabled={deploying || !address}
                    className="bg-purple-600 hover:bg-purple-700 text-white px-5 py-2 rounded font-medium disabled:opacity-50 flex items-center gap-2 transition-colors mb-4"
                >
                    {deploying && <Loader2 className="w-4 h-4 animate-spin" />}
                    Deploy Contract
                </button>
                {deployHash && (
                    <div className="bg-purple-50 p-4 rounded-lg border border-purple-100 text-sm mt-4">
                        <span className="font-semibold text-purple-900 block mb-1">Transaction Success!</span>
                        <div className="flex items-center gap-2 text-purple-800 break-all mb-2">
                            <CheckCircle className="w-4 h-4 text-purple-600" /> Tx Hash: {deployHash}
                        </div>
                        {address && (
                            <a 
                                href={`https://stellar.expert/explorer/testnet/contract/${address}`}
                                target="_blank"
                                rel="noreferrer"
                                className="text-blue-600 hover:underline font-medium"
                            >
                                View Contract on Stellar Expert (Testnet) ↗
                            </a>
                        )}
                    </div>
                )}
            </section>

            {/* SIGNERS SECTION */}
            <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <h2 className="text-xl font-semibold mb-4">Signers</h2>
                <div className="mb-4 text-sm text-gray-600">
                    Additional signer keys for this wallet, each with an optional spend limit. A wallet must always keep at least one signer.
                </div>
                <button
                    onClick={loadSigners}
                    disabled={loadingSigners || !address}
                    className="bg-gray-700 hover:bg-gray-800 text-white px-5 py-2 rounded font-medium disabled:opacity-50 flex items-center gap-2 transition-colors mb-4"
                >
                    {loadingSigners && <Loader2 className="w-4 h-4 animate-spin" />}
                    Load Signers
                </button>
                {signers.length > 0 && (
                    <ul className="space-y-2 mb-4">
                        {signers.map((s) => (
                            <li key={s.publicKeyHex} className="flex items-center justify-between gap-3 border border-gray-200 rounded p-3 text-sm">
                                <div className="min-w-0">
                                    <code className="block break-all text-gray-800">{s.publicKeyHex}</code>
                                    <span className="text-gray-500 text-xs">
                                        {s.spendLimit !== null ? `Spend limit: ${s.spendLimit}` : 'No spend limit'}
                                    </span>
                                </div>
                                <button
                                    onClick={() => removeSigner(s.publicKeyHex)}
                                    disabled={signerBusy || signers.length <= 1}
                                    title={signers.length <= 1 ? 'The last signer cannot be removed' : 'Remove signer'}
                                    className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded text-xs font-medium disabled:opacity-50"
                                >
                                    Remove
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                {signers.length === 1 && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-4">
                        This is the only signer, so it cannot be removed.
                    </div>
                )}
                <div className="space-y-2">
                    <input
                        type="text"
                        value={newSignerHex}
                        onChange={(e) => setNewSignerHex(e.target.value)}
                        placeholder="New signer public key (65-byte hex)"
                        className="border border-gray-300 rounded px-3 py-2 text-sm w-full outline-none focus:border-blue-500"
                    />
                    <input
                        type="text"
                        value={newSpendLimit}
                        onChange={(e) => setNewSpendLimit(e.target.value)}
                        placeholder="Spend limit (optional, integer)"
                        className="border border-gray-300 rounded px-3 py-2 text-sm w-full outline-none focus:border-blue-500"
                    />
                    <button
                        onClick={addSigner}
                        disabled={signerBusy || !address}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded font-medium disabled:opacity-50 flex items-center gap-2 transition-colors"
                    >
                        {signerBusy && <Loader2 className="w-4 h-4 animate-spin" />}
                        Add Signer
                    </button>
                </div>
                {signerMessage && (
                    <div className="mt-4 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded p-3">{signerMessage}</div>
                )}
            </section>

            {/* SIGN SECTION */}
            <section className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
                <h2 className="text-xl font-semibold mb-4">3. Sign Authority Entry</h2>
                <div className="mb-4 text-sm text-gray-600">
                    Signs a hardcoded 32-byte payload simulating a Soroban Authorization entry. Wait for WebAuthn prompt.
                </div>
                <button 
                    onClick={handleSign}
                    disabled={signing || isPending || !address}
                    className="bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded font-medium disabled:opacity-50 flex items-center gap-2 transition-colors"
                >
                    {(signing || isPending) && <Loader2 className="w-4 h-4 animate-spin" />}
                    Sign Auth Entry
                </button>
                {signatureResult && (
                    <div className="mt-4 bg-gray-900 text-green-400 p-4 rounded-lg text-xs font-mono overflow-auto max-h-64 shadow-inner">
                        <div className="mb-2 text-gray-400 font-sans font-semibold border-b border-gray-700 pb-2">WebAuthnSignature Output</div>
                        <div><span className="text-blue-400">publicKey:</span> {toHex(signatureResult.publicKey)}</div>
                        <div className="mt-2 text-gray-500">{"// " + signatureResult.publicKey.length + " bytes"}</div>
                        <br/>
                        <div><span className="text-blue-400">authData:</span> {toHex(signatureResult.authData)}</div>
                        <div className="mt-2 text-gray-500">{"// " + signatureResult.authData.length + " bytes"}</div>
                        <br/>
                        <div><span className="text-blue-400">clientDataJSON:</span> {toHex(signatureResult.clientDataJSON)}</div>
                        <div className="mt-2 text-gray-500">{"// " + signatureResult.clientDataJSON.length + " bytes"}</div>
                        <br/>
                        <div><span className="text-blue-400">signature:</span> {toHex(signatureResult.signature)}</div>
                        <div className="mt-2 text-gray-500">{"// " + signatureResult.signature.length + " bytes"}</div>
                    </div>
                )}
            </section>
        </main>
    );
}
