"use client";

import React, { useState } from 'react';
import { useInvisibleWallet, WebAuthnSignature } from 'invisible-wallet-sdk';
import { rpc, Keypair, Contract, xdr, TransactionBuilder, Networks } from 'stellar-sdk';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';
import { Buffer } from 'buffer';

const FACTORY_ADDRESS = process.env.NEXT_PUBLIC_FACTORY_ADDRESS || '';
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;

export default function Home() {
    const { address, isPending, error, register, signAuthEntry } = useInvisibleWallet(FACTORY_ADDRESS);
    
    const [username, setUsername] = useState('');
    const [localError, setLocalError] = useState<string | null>(null);
    const [deployHash, setDeployHash] = useState<string | null>(null);
    const [deploying, setDeploying] = useState(false);
    const [signatureResult, setSignatureResult] = useState<WebAuthnSignature | null>(null);
    const [signing, setSigning] = useState(false);

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
