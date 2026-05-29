"use client";

import React, { useState, useEffect } from 'react';
import { Loader2, CheckCircle, XCircle, Wallet } from 'lucide-react';

const FACTORY_ADDRESS = import.meta.env.PUBLIC_FACTORY_ADDRESS || '';
const RPC_URL = import.meta.env.PUBLIC_RPC_URL || 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = import.meta.env.PUBLIC_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';

type WebAuthnSignature = {
    publicKey: Uint8Array;
    authData: Uint8Array;
    clientDataJSON: Uint8Array;
    signature: Uint8Array;
};

export default function VeilWidget() {
    const [address, setAddress] = useState<string | null>(null);
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [username, setUsername] = useState('');
    const [signature, setSignature] = useState<WebAuthnSignature | null>(null);

    useEffect(() => {
        const stored = localStorage.getItem('invisible_wallet_address');
        if (stored) {
            setAddress(stored);
        }
    }, []);

    const bufferToHex = (buffer: Uint8Array | ArrayBuffer): string => {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    };

    const handleRegister = async () => {
        setIsPending(true);
        setError(null);

        try {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const name = username || `user_${Date.now()}`;
            const userId = new TextEncoder().encode(name);

            const credential = await navigator.credentials.create({
                publicKey: {
                    challenge,
                    rp: { name: 'Veil Astro Demo' },
                    user: {
                        id: userId,
                        name: name,
                        displayName: name,
                    },
                    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                    timeout: 60_000,
                    authenticatorSelection: {
                        residentKey: 'preferred',
                        userVerification: 'required',
                    },
                },
            }) as PublicKeyCredential;

            if (!credential) throw new Error('Credential creation failed');

            const response = credential.response as AuthenticatorAttestationResponse;
            const publicKeyBytes = await extractP256PublicKey(response);

            const walletAddress = computeWalletAddress(publicKeyBytes);

            localStorage.setItem('invisible_wallet_address', walletAddress);
            localStorage.setItem('invisible_wallet_key_id', credential.id);
            localStorage.setItem('invisible_wallet_public_key', bufferToHex(publicKeyBytes));
            setAddress(walletAddress);
        } catch (err: any) {
            setError(err.message || String(err));
        } finally {
            setIsPending(false);
        }
    };

    const handleSign = async () => {
        setIsPending(true);
        setError(null);

        try {
            const keyId = localStorage.getItem('invisible_wallet_key_id');
            if (!keyId) throw new Error('No passkey found. Register first.');

            const testPayload = new Uint8Array(32);
            testPayload.fill(7);

            const credIdBin = atob(keyId.replace(/-/g, '+').replace(/_/g, '/'));
            const credId = Uint8Array.from(credIdBin, c => c.charCodeAt(0));

            const assertion = await navigator.credentials.get({
                publicKey: {
                    challenge: testPayload.slice(
                        testPayload.byteOffset,
                        testPayload.byteOffset + testPayload.byteLength
                    ) as ArrayBuffer,
                    allowCredentials: [{ id: credId, type: 'public-key' }],
                    userVerification: 'required',
                },
            }) as PublicKeyCredential;

            if (!assertion) throw new Error('Signing was cancelled');

            const response = assertion.response as AuthenticatorAssertionResponse;
            const publicKeyHex = localStorage.getItem('invisible_wallet_public_key');
            if (!publicKeyHex) throw new Error('No public key found');

            const rawSignature = derToRawSignature(response.signature);
            const publicKeyBytes = hexToUint8Array(publicKeyHex);

            setSignature({
                publicKey: publicKeyBytes,
                authData: new Uint8Array(response.authenticatorData),
                clientDataJSON: new Uint8Array(response.clientDataJSON),
                signature: rawSignature,
            });
        } catch (err: any) {
            setError(err.message || String(err));
        } finally {
            setIsPending(false);
        }
    };

    const extractP256PublicKey = async (response: AuthenticatorAttestationResponse): Promise<Uint8Array> => {
        const spkiBuffer = response.getPublicKey();
        if (!spkiBuffer) {
            throw new Error(
                'getPublicKey() returned null — authenticator may not support SPKI export, ' +
                'or the browser is too old (requires Chrome 95+ / Firefox 93+)'
            );
        }

        const cryptoKey = await crypto.subtle.importKey(
            'spki',
            spkiBuffer,
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['verify']
        );

        const rawBuffer = await crypto.subtle.exportKey('raw', cryptoKey);
        return new Uint8Array(rawBuffer);
    };

    const computeWalletAddress = (publicKeyBytes: Uint8Array): string => {
        // Simplified derivation for demo
        // Real implementation uses SDK's computeWalletAddress with factory + XDR
        const hash = publicKeyBytes.slice(1);
        return `C${Buffer.from(hash).toString('hex').toUpperCase().slice(0, 55)}`;
    };

    const derToRawSignature = (derSig: ArrayBuffer): Uint8Array => {
        const der = new Uint8Array(derSig);
        if (der[0] !== 0x30) throw new Error('DER: expected SEQUENCE');
        let offset = 2;

        if (der[offset] !== 0x02) throw new Error('DER: expected INTEGER for r');
        offset++;
        const rLen = der[offset++];
        const rRaw = der.slice(offset, offset + rLen);
        offset += rLen;

        if (der[offset] !== 0x02) throw new Error('DER: expected INTEGER for s');
        offset++;
        const sLen = der[offset++];
        const sRaw = der.slice(offset, offset + sLen);

        const SECP256R1_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
        const SECP256R1_HALF_N = SECP256R1_N >> 1n;

        let s = 0n;
        for (const b of sRaw) s = (s << 8n) | BigInt(b);
        if (s > SECP256R1_HALF_N) s = SECP256R1_N - s;
        const normalizedS = new Uint8Array(32);
        for (let i = 31; i >= 0; i--) {
            normalizedS[i] = Number(s & 0xffn);
            s >>= 8n;
        }

        const normalizedR = new Uint8Array(32);
        let rOffset = 0;
        while (rOffset < rRaw.length - 32 && rRaw[rOffset] === 0) rOffset++;
        normalizedR.set(rRaw.slice(rOffset), 32 - rRaw.slice(rOffset).length);

        const raw = new Uint8Array(64);
        raw.set(normalizedR, 0);
        raw.set(normalizedS, 32);
        return raw;
    };

    const hexToUint8Array = (hex: string): Uint8Array => {
        if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
        const array = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            array[i / 2] = parseInt(hex.substring(i, i + 2), 16);
        }
        return array;
    };

    return (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 max-w-sm w-full">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Wallet className="w-5 h-5 text-blue-600" />
                Veil Passkey Wallet
            </h2>

            {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-lg flex items-start gap-3 mb-4">
                    <XCircle className="w-5 h-5 mt-0.5 shrink-0" />
                    <span className="text-sm">{error}</span>
                </div>
            )}

            <div className="space-y-4">
                <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Enter username (optional)"
                    className="border border-gray-300 rounded px-3 py-2 text-sm w-full outline-none focus:border-blue-500 transition-colors"
                />

                <button
                    onClick={handleRegister}
                    disabled={isPending}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded font-medium disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
                >
                    {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                    Connect with Passkey
                </button>

                {address && !signature && (
                    <button
                        onClick={handleSign}
                        disabled={isPending}
                        className="w-full bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded font-medium disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
                    >
                        Sign Auth Entry
                    </button>
                )}

                {address && (
                    <div className="bg-green-50 p-4 rounded-lg border border-green-100 text-sm">
                        <span className="font-semibold text-green-900 block mb-1 flex items-center gap-1">
                            <CheckCircle className="w-4 h-4" /> Connected Address:
                        </span>
                        <code className="text-green-800 break-all text-xs">{address}</code>
                    </div>
                )}

                {signature && (
                    <div className="mt-4 bg-gray-900 text-green-400 p-4 rounded-lg text-xs font-mono overflow-auto max-h-64 shadow-inner">
                        <div className="mb-2 text-gray-400 font-sans font-semibold border-b border-gray-700 pb-2">WebAuthnSignature Output</div>
                        <div><span className="text-blue-400">publicKey:</span> {bufferToHex(signature.publicKey)}</div>
                        <div><span className="text-blue-400">authData:</span> {bufferToHex(signature.authData)}</div>
                        <div><span className="text-blue-400">clientDataJSON:</span> {bufferToHex(signature.clientDataJSON)}</div>
                        <div><span className="text-blue-400">signature:</span> {bufferToHex(signature.signature)}</div>
                    </div>
                )}
            </div>
        </div>
    );
}