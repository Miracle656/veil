import { Networks, Keypair } from '@stellar/stellar-sdk';
export const appConfig = {
    factoryAddress: import.meta.env.VITE_FACTORY_ADDRESS ?? '',
    rpcUrl: import.meta.env.VITE_RPC_URL ?? 'https://soroban-testnet.stellar.org',
    horizonUrl: import.meta.env.VITE_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    networkPassphrase: import.meta.env.VITE_NETWORK_PASSPHRASE ?? Networks.TESTNET,
    friendbotUrl: import.meta.env.VITE_FRIENDBOT_URL ?? 'https://friendbot.stellar.org',
    explorerBaseUrl: import.meta.env.VITE_EXPLORER_BASE_URL ?? 'https://stellar.expert/explorer/testnet',
};
export const storageKeys = {
    walletAddress: 'invisible_wallet_address',
    credentialId: 'invisible_wallet_key_id',
    publicKey: 'invisible_wallet_public_key',
    signerSecret: 'veil_signer_secret',
    signerPublicKey: 'veil_signer_public_key',
};
export function persistSession(walletAddress, signerSecret, signerPublicKey) {
    localStorage.setItem(storageKeys.walletAddress, walletAddress);
    localStorage.setItem(storageKeys.signerSecret, signerSecret);
    localStorage.setItem(storageKeys.signerPublicKey, signerPublicKey);
    sessionStorage.setItem(storageKeys.walletAddress, walletAddress);
    sessionStorage.setItem(storageKeys.signerSecret, signerSecret);
}
export function readWalletAddress() {
    return sessionStorage.getItem(storageKeys.walletAddress) ?? localStorage.getItem(storageKeys.walletAddress);
}
export function readSignerSecret() {
    return sessionStorage.getItem(storageKeys.signerSecret) ?? localStorage.getItem(storageKeys.signerSecret);
}
export function readSignerPublicKey() {
    return localStorage.getItem(storageKeys.signerPublicKey);
}
export function readCredentialId() {
    return localStorage.getItem(storageKeys.credentialId);
}
export function readPublicKey() {
    return localStorage.getItem(storageKeys.publicKey);
}
export function base64urlToBytes(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}
export function bytesToHex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function deriveFeePayerKeypair(credentialIdBase64url) {
    const credentialId = base64urlToBytes(credentialIdBase64url);
    const keyMaterial = await crypto.subtle.importKey('raw', credentialId, 'HKDF', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('veil:feepayer:salt:v1'), info: new TextEncoder().encode('veil:feepayer:ed25519:v1') }, keyMaterial, 256);
    return Keypair.fromRawEd25519Seed(new Uint8Array(derived));
}
export async function requirePasskeyAssertion(credentialIdBase64url, challenge) {
    const assertion = await navigator.credentials.get({
        publicKey: {
            challenge: challenge,
            allowCredentials: [{ id: base64urlToBytes(credentialIdBase64url), type: 'public-key' }],
            userVerification: 'required',
        },
    });
    if (!assertion) {
        throw new Error('Passkey verification was cancelled.');
    }
    return assertion;
}
