import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { p256 } from '@noble/curves/nist';
import { sha256 } from '@noble/hashes/sha256';
import { hexToUint8Array } from '@veil/utils';
import {
  Sep30Client,
  collectRecoverySignatures,
  type Sep30Identity,
  type Sep30Account,
  type RecoveryServer,
  type CollectedSignature,
} from '@veil/recovery';

export function generateMnemonicPhrase(): string {
  return bip39.generateMnemonic(wordlist);
}

export function deriveP256KeyPair(mnemonic: string): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const privateKey = sha256(seed);
  const publicKey = p256.getPublicKey(privateKey, false); // 65-byte uncompressed public key
  return { privateKey, publicKey };
}

export function signWithP256(payload: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const sig = p256.sign(payload, privateKey);
  return sig.toCompactRawBytes();
}

// Custom base64 helpers for browser compatibility without Buffer
function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(buffer as any);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as any,
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptMnemonic(mnemonic: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(mnemonic)
  );

  const payload = {
    salt: arrayBufferToBase64(salt),
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(encrypted),
  };
  return JSON.stringify(payload);
}

export async function decryptMnemonic(encryptedJson: string, passphrase: string): Promise<string> {
  const payload = JSON.parse(encryptedJson);
  const salt = new Uint8Array(base64ToArrayBuffer(payload.salt));
  const iv = new Uint8Array(base64ToArrayBuffer(payload.iv));
  const ciphertext = new Uint8Array(base64ToArrayBuffer(payload.ciphertext));

  const key = await deriveKey(passphrase, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  const dec = new TextDecoder();
  return dec.decode(decrypted);
}

const DB_NAME = 'VeilBackupDB';
const DB_VERSION = 1;
const STORE_NAME = 'backup';
const BACKUP_KEY = 'encryptedMnemonic';

export function storeEncryptedMnemonic(encrypted: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return resolve(); // SSR fallback
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const putReq = store.put(encrypted, BACKUP_KEY);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
      tx.oncomplete = () => db.close();
    };
    request.onerror = () => reject(request.error);
  });
}

export function getEncryptedMnemonic(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return resolve(null); // SSR fallback
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(BACKUP_KEY);
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => db.close();
    };
    request.onerror = () => reject(request.error);
  });
}

// Helper to base64url encode a Uint8Array
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// Convert ASN.1 DER-encoded P-256 signature back to raw compact format
export function rawToDerSignature(rawSig: Uint8Array): Uint8Array {
  const r = rawSig.slice(0, 32);
  const s = rawSig.slice(32, 64);

  const formatInteger = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length && bytes[start] === 0) start++;
    let trimmed = bytes.slice(start);
    if (trimmed.length === 0) {
      trimmed = new Uint8Array([0]);
    }
    if ((trimmed[0] & 0x80) !== 0) {
      const prepended = new Uint8Array(trimmed.length + 1);
      prepended.set(trimmed, 1);
      return prepended;
    }
    return trimmed;
  };

  const rDer = formatInteger(r);
  const sDer = formatInteger(s);

  const totalLen = rDer.length + sDer.length + 4;
  const der = new Uint8Array(totalLen + 2);
  der[0] = 0x30;
  der[1] = totalLen;
  der[2] = 0x02;
  der[3] = rDer.length;
  der.set(rDer, 4);
  const sOffset = 4 + rDer.length;
  der[sOffset] = 0x02;
  der[sOffset + 1] = sDer.length;
  der.set(sDer, sOffset + 2);

  return der;
}

// Emulate a standard 5-element WebAuthn signature using P-256 recovery key
export function generateRecoveryWebAuthnSignature(
  challenge: Uint8Array,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  rpId: string = typeof window !== 'undefined' ? window.location.hostname : 'localhost',
  origin: string = typeof window !== 'undefined' ? window.location.origin : `https://${rpId}`
): { publicKey: Uint8Array; authData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array } {
  const rpIdHash = sha256(new TextEncoder().encode(rpId));
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = 0x05; // UP | UV flags

  const challengeB64 = base64url(challenge);
  const clientDataObj = {
    type: 'webauthn.get',
    challenge: challengeB64,
    origin,
    crossOrigin: false,
  };
  const clientDataJSON = new TextEncoder().encode(JSON.stringify(clientDataObj));
  const clientDataHash = sha256(clientDataJSON);

  const message = new Uint8Array(authData.length + clientDataHash.length);
  message.set(authData, 0);
  message.set(clientDataHash, authData.length);
  const messageHash = sha256(message);

  const sig = p256.sign(messageHash, privateKey);
  const signature = sig.toCompactRawBytes();

  return {
    publicKey,
    authData,
    clientDataJSON,
    signature,
  };
}

// Patch navigator.credentials.get globally to intercept calls when wallet is in recovery mode
export function initRecoveryInterceptor() {
  if (typeof window === 'undefined' || !navigator.credentials) return;
  if ((navigator.credentials.get as any).__patched) return;

  const originalGet = navigator.credentials.get.bind(navigator.credentials);
  
  const patchedGet = async function (options: any) {
    const keyId = localStorage.getItem('invisible_wallet_key_id');
    if (keyId === 'recovery') {
      const privateKeyHex = sessionStorage.getItem('invisible_wallet_recovery_private_key')
        || localStorage.getItem('invisible_wallet_recovery_private_key');
      const publicKeyHex = localStorage.getItem('invisible_wallet_public_key');
      if (!publicKeyHex) throw new Error('Recovery public key not found in storage. Please log in again.');
      if (!privateKeyHex) throw new Error('Recovery private key not found in session storage. Please log in again.');

      const privateKey = hexToUint8Array(privateKeyHex);
      const publicKey = hexToUint8Array(publicKeyHex);
      
      let challenge: Uint8Array;
      if (options?.publicKey?.challenge) {
        challenge = new Uint8Array(options.publicKey.challenge);
      } else {
        throw new Error('challenge is required for WebAuthn authentication');
      }

      const rpId = options?.publicKey?.rpId || window.location.hostname;
      const origin = window.location.origin;
      const emulated = generateRecoveryWebAuthnSignature(challenge, privateKey, publicKey, rpId, origin);
      const derSig = rawToDerSignature(emulated.signature);

      return {
        id: 'recovery',
        rawId: new Uint8Array(options.publicKey.allowCredentials?.[0]?.id || []),
        type: 'public-key',
        response: {
          authenticatorData: emulated.authData.buffer,
          clientDataJSON: emulated.clientDataJSON.buffer,
          signature: derSig.buffer,
          userHandle: new Uint8Array([1]).buffer,
        },
      } as any;
    }
    return originalGet(options);
  };
  (patchedGet as any).__patched = true;
  navigator.credentials.get = patchedGet;
}

// ── SEP-30 server-assisted recovery ─────────────────────────────────────────────
//
// The mnemonic-backup path above is fully self-custodial. SEP-30 complements it
// with *server-assisted* recovery: the user registers identities with one or
// more recovery servers, and after device loss those servers co-sign a
// transaction that installs a fresh signer — no single party holds the key.
//
// The transport-level SEP-30 client lives in the SDK (`@veil/recovery`); the
// helpers below wire it to the wallet's storage and the configured servers.

export interface RecoveryServerConfig {
  /** Base URL of the recovery server. */
  baseUrl: string;
  /** Optional SEP-10 JWT (or use getAuthToken for rotating tokens). */
  authToken?: string;
  /** Lazily resolve the current SEP-10 JWT before each request. */
  getAuthToken?: () => string | null | undefined | Promise<string | null | undefined>;
}

const RECOVERY_SERVERS_KEY = 'invisible_wallet_recovery_servers';

/** Build a SEP-30 client for each configured recovery server. */
export function buildRecoveryClients(configs: RecoveryServerConfig[]): Sep30Client[] {
  return configs.map((c) => new Sep30Client(c));
}

/**
 * Persist the list of recovery-server base URLs so they can be rediscovered
 * after device loss (the URLs are not secret; tokens are never stored here).
 */
export function rememberRecoveryServers(configs: RecoveryServerConfig[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(RECOVERY_SERVERS_KEY, JSON.stringify(configs.map((c) => c.baseUrl)));
}

/** Read back the previously remembered recovery-server base URLs. */
export function getRememberedRecoveryServers(): string[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(RECOVERY_SERVERS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Register the wallet account with every configured recovery server and persist
 * the server URLs for later recovery. Returns each server's account view
 * (including the signer it contributes, which must then be added on-chain).
 */
export async function registerWithRecoveryServers(
  address: string,
  identities: Sep30Identity[],
  configs: RecoveryServerConfig[],
): Promise<Sep30Account[]> {
  const clients = buildRecoveryClients(configs);
  const accounts = await Promise.all(clients.map((c) => c.registerAccount(address, identities)));
  rememberRecoveryServers(configs);
  return accounts;
}

/**
 * Resolve each configured server into a {@link RecoveryServer} (client + the
 * server's signer key on the account), ready for {@link recoverSignatures}.
 * Servers that don't have the account registered are skipped.
 */
export async function resolveRecoveryServers(
  address: string,
  configs: RecoveryServerConfig[],
): Promise<RecoveryServer[]> {
  const clients = buildRecoveryClients(configs);
  const resolved = await Promise.all(
    clients.map(async (client): Promise<RecoveryServer | null> => {
      try {
        const account = await client.getAccount(address);
        const signerKey = account.signers[0]?.key;
        return signerKey ? { client, signerKey } : null;
      } catch {
        return null;
      }
    }),
  );
  return resolved.filter((r): r is RecoveryServer => r !== null);
}

/**
 * Collect recovery-server signatures for a transaction that re-establishes a
 * signer after device loss. Pass `requireAll: false` for an M-of-N threshold.
 */
export async function recoverSignatures(
  servers: RecoveryServer[],
  address: string,
  transactionXdr: string,
  opts: { requireAll?: boolean } = {},
): Promise<CollectedSignature[]> {
  return collectRecoverySignatures(servers, address, transactionXdr, opts);
}

