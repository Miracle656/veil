import './polyfills';

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { Core } from '@walletconnect/core';
import { getSdkError } from '@walletconnect/utils';
import { Web3Wallet, type IWeb3Wallet } from '@walletconnect/web3wallet';
import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';

import { getNetwork } from './network';
import {
  WALLET_CONNECT_EVENTS,
  WALLET_CONNECT_METHODS,
  buildWcError,
  buildWcResult,
  extractRequestXdr,
  getChainId as computeChainId,
  isUserRejection,
  normalizeWalletConnectUri,
  parseWalletConnectRequest,
  parseWalletConnectSession,
} from './walletConnectHelpers';
import { getSignerSecret } from './walletStore';

export type {
  WalletConnectPeer,
  WalletConnectProposal,
  WalletConnectRequest,
  WalletConnectSession,
} from './walletConnectHelpers';

import type {
  WalletConnectProposal,
  WalletConnectRequest,
  WalletConnectSession,
} from './walletConnectHelpers';

/**
 * WalletConnect v2 integration for the mobile wallet.
 *
 * Ported from `frontend/wallet/lib/walletConnect.ts`. The signing pipeline is
 * unchanged; what differs is the runtime plumbing:
 *
 * - `@walletconnect/react-native-compat` and friends are loaded via
 *   `./polyfills` before anything else in this module.
 * - Session snapshots persist to `AsyncStorage` instead of `sessionStorage`.
 * - Hashing goes through `expo-crypto`, since Hermes has no `crypto.subtle`.
 * - The passkey assertion is supplied by a registered signer rather than by
 *   calling `navigator.credentials` directly, so this module stays free of any
 *   particular passkey implementation.
 * - Incoming requests are held in a subscribable queue instead of dispatched as
 *   DOM events, so a modal that mounts after the request still sees it.
 */

const SESSION_STORAGE_KEY = 'veil_walletconnect_sessions';

/** Assertion produced by the device passkey over a Soroban auth-entry hash. */
export type WebAuthnSignature = {
  publicKey: Uint8Array;
  authData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
};

/**
 * Signs one Soroban authorization-entry payload hash with the user's passkey.
 * Return null to signal that the user declined the prompt.
 */
export type AuthEntrySigner = (payloadHash: Uint8Array) => Promise<WebAuthnSignature | null>;

type SessionListener = (sessions: WalletConnectSession[]) => void;
type ProposalListener = (proposal: WalletConnectProposal | null) => void;
type RequestListener = (requests: WalletConnectRequest[]) => void;

let _client: IWeb3Wallet | null = null;
let _clientPromise: Promise<IWeb3Wallet> | null = null;
let _sessions: WalletConnectSession[] = [];
let _pendingProposal: WalletConnectProposal | null = null;
let _pendingRequests: WalletConnectRequest[] = [];
let _authEntrySigner: AuthEntrySigner | null = null;

const sessionListeners = new Set<SessionListener>();
const proposalListeners = new Set<ProposalListener>();
const requestListeners = new Set<RequestListener>();

// ── Passkey signer injection ──────────────────────────────────────────────────

/**
 * Register the passkey signer used to authorise dApp requests. Returns an
 * unregister function. Without a registered signer, signing requests fail with
 * a clear error rather than silently doing nothing.
 */
export function registerAuthEntrySigner(signer: AuthEntrySigner): () => void {
  _authEntrySigner = signer;
  return () => {
    if (_authEntrySigner === signer) _authEntrySigner = null;
  };
}

export function hasAuthEntrySigner(): boolean {
  return _authEntrySigner !== null;
}

// ── State plumbing ────────────────────────────────────────────────────────────

function notifySessions(): void {
  const snapshot = [..._sessions];
  for (const listener of sessionListeners) listener(snapshot);
}

function notifyProposal(): void {
  for (const listener of proposalListeners) listener(_pendingProposal);
}

function notifyRequests(): void {
  const snapshot = [..._pendingRequests];
  for (const listener of requestListeners) listener(snapshot);
}

function getChainId(): string {
  return computeChainId(getNetwork().name);
}

async function loadStoredSessions(): Promise<WalletConnectSession[]> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WalletConnectSession[]) : [];
  } catch {
    return [];
  }
}

async function persistSessions(sessions: WalletConnectSession[]): Promise<void> {
  try {
    await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
  } catch (error) {
    console.warn('[walletConnect] failed to persist sessions', error);
  }
}

async function syncSessionsFromClient(client: IWeb3Wallet): Promise<void> {
  const fallbackChainId = getChainId();
  _sessions = Object.values(client.getActiveSessions()).map((session) =>
    parseWalletConnectSession(session, fallbackChainId)
  );
  notifySessions();
  await persistSessions(_sessions);
}

function removePendingRequest(id: number, topic: string): void {
  const next = _pendingRequests.filter(
    (request) => !(request.id === id && request.topic === topic)
  );
  if (next.length === _pendingRequests.length) return;
  _pendingRequests = next;
  notifyRequests();
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

/**
 * Hermes has no `crypto.subtle`, so hashing goes through `expo-crypto`, which
 * only accepts views backed by a plain `ArrayBuffer`.
 */
async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data);
  return new Uint8Array(digest);
}

async function getFeePayerKeypair(): Promise<Keypair> {
  const secret = await getSignerSecret();
  if (!secret) {
    throw new Error('No fee-payer signer secret found on this device.');
  }
  return Keypair.fromSecret(secret);
}

function getRpcServer(): SorobanRpc.Server {
  return new SorobanRpc.Server(getNetwork().rpcUrl);
}

/**
 * Read the wallet contract's replay nonce. Returns null for contracts that do
 * not expose `get_nonce`, in which case the signature vector omits it.
 */
async function getWalletNonce(
  rpc: SorobanRpc.Server,
  contractAddress: string,
  networkPassphrase: string
): Promise<bigint | null> {
  try {
    const dummyKeypair = Keypair.random();
    const dummyAccount = new Account(dummyKeypair.publicKey(), '0');
    const probeTx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(new Contract(contractAddress).call('get_nonce'))
      .setTimeout(30)
      .build();

    const sim = await rpc.simulateTransaction(probeTx);
    if (SorobanRpc.Api.isSimulationError(sim)) return null;

    const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result;
    if (!result?.retval) return null;
    return scValToNative(result.retval) as bigint;
  } catch {
    return null;
  }
}

// ── Signing ───────────────────────────────────────────────────────────────────

async function signAuthEntry(payloadHash: Uint8Array): Promise<WebAuthnSignature | null> {
  if (!_authEntrySigner) {
    throw new Error('No passkey signer registered. Unlock the wallet and try again.');
  }
  return _authEntrySigner(payloadHash);
}

/**
 * Sign a dApp-supplied transaction with the wallet passkey and the fee payer.
 *
 * Mirrors the browser wallet: simulate in recording mode, sign each Soroban
 * address credential with the passkey, re-simulate in enforce mode so the
 * footprint covers the wallet contract storage that `__check_auth` reads, then
 * assemble and sign with the fee payer.
 */
async function signXdrPayload(xdrString: string): Promise<string> {
  const network = getNetwork();
  const rpc = getRpcServer();
  const feePayerKeypair = await getFeePayerKeypair();
  const tx = TransactionBuilder.fromXDR(xdrString, network.networkPassphrase);

  // Small CPU leeway for host-function ECDSA verification not modeled by
  // recording-mode simulation.
  const sim = await rpc.simulateTransaction(tx, { cpuInstructions: 5_000_000 } as any);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  // Recording-mode simulation returns auth entries with
  // signatureExpirationLedger=0 — set a real future ledger so the host doesn't
  // reject the auth as expired. The same value must appear in both the signed
  // preimage and the credential we attach.
  const latestLedger = await rpc.getLatestLedger();
  const validUntilLedger = latestLedger.sequence + 100;

  const successSim = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse;
  const authEntries = successSim.result?.auth;

  if (authEntries) {
    const networkIdBytes = await sha256(new TextEncoder().encode(network.networkPassphrase));

    for (const parsed of authEntries) {
      const credentials = parsed.credentials();
      if (
        credentials.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value
      ) {
        continue;
      }

      const addressCredentials = credentials.address();
      const contractAddress = Address.fromScAddress(addressCredentials.address()).toString();
      const currentNonce = await getWalletNonce(rpc, contractAddress, network.networkPassphrase);

      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: Buffer.from(networkIdBytes),
          nonce: addressCredentials.nonce(),
          invocation: parsed.rootInvocation(),
          signatureExpirationLedger: validUntilLedger,
        })
      );
      const payloadHash = await sha256(new Uint8Array(preimage.toXDR()));

      const webAuthnSig = await signAuthEntry(payloadHash);
      if (!webAuthnSig) {
        throw new Error('USER_REJECTED');
      }

      const sigElements = [
        nativeToScVal(webAuthnSig.publicKey, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.authData, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
        nativeToScVal(webAuthnSig.signature, { type: 'bytes' }),
      ];
      if (currentNonce !== null) {
        sigElements.push(nativeToScVal(currentNonce, { type: 'u64' }));
      }

      parsed.credentials(
        xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: addressCredentials.address(),
            nonce: addressCredentials.nonce(),
            signatureExpirationLedger: validUntilLedger,
            signature: xdr.ScVal.scvVec(sigElements),
          })
        )
      );
    }
  }

  const invokeOp = tx.operations[0] as Operation.InvokeHostFunction;
  const feePayerAccount = await rpc.getAccount(feePayerKeypair.publicKey());
  const signedTx = new TransactionBuilder(feePayerAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: invokeOp.func,
        auth: authEntries ?? [],
        source: invokeOp.source,
      })
    )
    .setTimeout(30)
    .build();

  const enforceSim = await rpc.simulateTransaction(signedTx);
  if (SorobanRpc.Api.isSimulationError(enforceSim)) {
    throw new Error(`Re-simulation (enforce mode) failed: ${enforceSim.error}`);
  }

  const assembled = SorobanRpc.assembleTransaction(signedTx, enforceSim).build();
  assembled.sign(feePayerKeypair);
  return assembled.toXDR();
}

async function signAndSubmitXdr(xdrString: string): Promise<string> {
  const network = getNetwork();
  const rpc = getRpcServer();
  const signedXDR = await signXdrPayload(xdrString);
  const signedTx = TransactionBuilder.fromXDR(signedXDR, network.networkPassphrase);

  const sendResult = await rpc.sendTransaction(signedTx);
  if (sendResult.status === 'ERROR') {
    throw new Error(
      `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`
    );
  }
  return sendResult.hash;
}

// ── Request handling ──────────────────────────────────────────────────────────

/**
 * Sign and answer an incoming `session_request`. Errors are converted into
 * JSON-RPC error responses so the dApp always gets a definitive answer instead
 * of hanging, then re-thrown so the caller can surface them in the UI.
 */
export async function approveWalletConnectRequest(request: WalletConnectRequest): Promise<void> {
  const client = await getWalletConnectClient();
  const { topic, id, method, params } = request;

  if (method !== 'stellar_signXDR' && method !== 'stellar_signAndSubmitXDR') {
    await client.respondSessionRequest({
      topic,
      response: buildWcError(id, 10001, `Unsupported method: ${String(method)}`),
    });
    removePendingRequest(id, topic);
    throw new Error(`Unsupported method: ${String(method)}`);
  }

  try {
    const xdrString = extractRequestXdr(params);
    if (!xdrString) {
      throw new Error('Missing XDR payload in WalletConnect request.');
    }

    const result =
      method === 'stellar_signXDR'
        ? { signedXDR: await signXdrPayload(xdrString) }
        : { txHash: await signAndSubmitXdr(xdrString) };

    await client.respondSessionRequest({ topic, response: buildWcResult(id, result) });
    removePendingRequest(id, topic);
  } catch (error: unknown) {
    const reason = isUserRejection(error) ? getSdkError('USER_REJECTED') : null;
    const response = reason
      ? buildWcError(id, reason.code, reason.message)
      : buildWcError(id, 5000, error instanceof Error ? error.message : String(error));

    await client.respondSessionRequest({ topic, response }).catch(() => {});
    removePendingRequest(id, topic);
    throw error;
  }
}

/** Answer an incoming request with an explicit user rejection. */
export async function rejectWalletConnectRequest(request: WalletConnectRequest): Promise<void> {
  const client = await getWalletConnectClient();
  const reason = getSdkError('USER_REJECTED');
  await client.respondSessionRequest({
    topic: request.topic,
    response: buildWcError(request.id, reason.code, reason.message),
  });
  removePendingRequest(request.id, request.topic);
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export function subscribeWalletConnectSessions(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  listener([..._sessions]);
  return () => {
    sessionListeners.delete(listener);
  };
}

export function subscribeWalletConnectProposal(listener: ProposalListener): () => void {
  proposalListeners.add(listener);
  listener(_pendingProposal);
  return () => {
    proposalListeners.delete(listener);
  };
}

export function subscribeWalletConnectRequests(listener: RequestListener): () => void {
  requestListeners.add(listener);
  listener([..._pendingRequests]);
  return () => {
    requestListeners.delete(listener);
  };
}

export function getWalletConnectSessions(): WalletConnectSession[] {
  return [..._sessions];
}

export function getPendingWalletConnectProposal(): WalletConnectProposal | null {
  return _pendingProposal;
}

export function getPendingWalletConnectRequests(): WalletConnectRequest[] {
  return [..._pendingRequests];
}

// ── Client lifecycle ──────────────────────────────────────────────────────────

async function initClient(): Promise<IWeb3Wallet> {
  const projectId = process.env['EXPO_PUBLIC_WC_PROJECT_ID']?.trim();
  if (!projectId) {
    throw new Error('EXPO_PUBLIC_WC_PROJECT_ID is missing.');
  }

  // Show sessions from the last run immediately; the client overwrites them
  // with the authoritative list once it has finished restoring.
  _sessions = await loadStoredSessions();
  notifySessions();

  const client = await Web3Wallet.init({
    core: new Core({ projectId }),
    metadata: {
      name: 'Veil Wallet',
      description: 'Passkey-powered Stellar wallet.',
      url: 'https://veil.app',
      icons: ['https://veil.app/icon.png'],
    },
  });

  client.on('session_proposal', (proposal: any) => {
    _pendingProposal = proposal;
    notifyProposal();
  });

  client.on('session_delete', (event: any) => {
    _sessions = _sessions.filter((session) => session.topic !== event.topic);
    notifySessions();
    void persistSessions(_sessions);
  });

  client.on('session_request', (event: any) => {
    _pendingRequests = [..._pendingRequests, parseWalletConnectRequest(event)];
    notifyRequests();
  });

  _client = client;
  await syncSessionsFromClient(client);
  return client;
}

/**
 * Lazily initialise the WalletConnect client. Concurrent callers share one
 * in-flight init; a failed init is not cached, so a later call can retry.
 */
export function getWalletConnectClient(): Promise<IWeb3Wallet> {
  if (_client) return Promise.resolve(_client);
  if (!_clientPromise) {
    _clientPromise = initClient().catch((error) => {
      _clientPromise = null;
      throw error;
    });
  }
  return _clientPromise;
}

// ── Pairing and sessions ──────────────────────────────────────────────────────

/** Pair with a dApp from a scanned or pasted `wc:` URI. */
export async function pairWalletConnect(uri: string): Promise<void> {
  const normalized = normalizeWalletConnectUri(uri);
  const client = await getWalletConnectClient();
  await client.pair({ uri: normalized });
}

export async function approveSession(
  proposal: WalletConnectProposal,
  contractAddress: string
): Promise<void> {
  if (!contractAddress.startsWith('C')) {
    throw new Error('Wallet address must be a Stellar contract address (C...).');
  }

  const client = await getWalletConnectClient();
  const chainId = getChainId();

  await client.approveSession({
    id: proposal.id,
    namespaces: {
      stellar: {
        methods: WALLET_CONNECT_METHODS,
        chains: [chainId],
        events: WALLET_CONNECT_EVENTS,
        accounts: [`${chainId}:${contractAddress}`],
      },
    },
  });

  _pendingProposal = null;
  notifyProposal();
  await syncSessionsFromClient(client);
}

export async function rejectSession(proposal: WalletConnectProposal): Promise<void> {
  const client = await getWalletConnectClient();
  await client.rejectSession({ id: proposal.id, reason: getSdkError('USER_REJECTED') });
  _pendingProposal = null;
  notifyProposal();
}

export async function disconnectSession(topic: string): Promise<void> {
  const client = await getWalletConnectClient();
  await client.disconnectSession({ topic, reason: getSdkError('USER_DISCONNECTED') });
  _sessions = _sessions.filter((session) => session.topic !== topic);
  notifySessions();
  await persistSessions(_sessions);
}

export async function disconnectAllSessions(): Promise<void> {
  const client = _client;
  if (client) {
    await Promise.all(
      _sessions.map((session) =>
        client
          .disconnectSession({ topic: session.topic, reason: getSdkError('USER_DISCONNECTED') })
          .catch(() => {})
      )
    );
  }
  _sessions = [];
  notifySessions();
  await persistSessions([]);
}
