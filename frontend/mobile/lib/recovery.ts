import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  rpc as SorobanRpc,
  xdr,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';
import * as Passkeys from 'react-native-passkeys';

import { getNetwork, type VeilNetwork } from './network';
import { setPasskeyCredential, setWalletAddress } from './walletStore';
import { base64UrlToUint8Array, uint8ArrayToBase64Url } from './webauthn';

/**
 * SEP-30 server-assisted recovery.
 *
 * A passkey-only wallet has no seed phrase to fall back on, so losing the device
 * means losing the only signer — unless something else can vouch for the owner.
 * SEP-30 recovery servers are that something: while the wallet is healthy the
 * owner registers identities (phone, email, another Stellar address) with one or
 * more servers, and the wallet contract's recovery key is set to an address the
 * servers control. After device loss the owner re-authenticates those identities
 * and the servers co-sign the transaction that binds a fresh signer — no single
 * party ever holds the key.
 *
 * On-chain this maps onto the wallet contract's two-step recovery:
 * `request_recovery(new_signer)`, authorized by the recovery-key address, starts
 * a 7-day timelock; `finalize_recovery()` is permissionless once the timelock
 * expires and installs the new signer. The delay is deliberate — it gives an
 * owner who still holds their key time to cancel a recovery they did not start.
 *
 * The transport client is ported from `sdk/src/recovery/sep30.ts` and kept in the
 * app so mobile has no dependency on the browser SDK build. SEP-10
 * authentication is out of scope, as it is in the SDK: callers supply the JWT.
 */

// ── SEP-30 transport ──────────────────────────────────────────────────────────

/** A signer a recovery server contributes to an account. */
export type Sep30Signer = { key: string; added_at?: string };

/** Recovery-server view of a registered account. */
export type Sep30Account = {
  address: string;
  identities: Array<{ role: string; authenticated?: boolean }>;
  signers: Sep30Signer[];
};

/** A signature returned by a recovery server for a submitted transaction. */
export type Sep30Signature = {
  /** Base64 signature to attach to the transaction. */
  signature: string;
  /** Network passphrase the signature is valid for. */
  network_passphrase: string;
};

export type RecoveryServerConfig = {
  /** Base URL of the recovery server. */
  baseUrl: string;
  /** SEP-10 JWT for an identity on the account, when the server requires one. */
  authToken?: string;
};

/** Thrown when a recovery server returns a non-2xx response. */
export class Sep30Error extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'Sep30Error';
  }
}

export class Sep30Client {
  private readonly baseUrl: string;
  private readonly authToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(config: RecoveryServerConfig, fetchImpl: typeof fetch = fetch) {
    if (!config.baseUrl) throw new Error('Sep30Client requires a baseUrl');
    // Normalise a trailing slash so path joins are predictable.
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.authToken = config.authToken;
    this.fetchImpl = fetchImpl;
  }

  get url(): string {
    return this.baseUrl;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `Recovery server responded ${response.status}`;
      throw new Sep30Error(response.status, message);
    }
    return parsed as T;
  }

  /** The server's view of an account: its signers and which identities are authenticated. */
  getAccount(address: string): Promise<Sep30Account> {
    return this.request<Sep30Account>('GET', `/accounts/${address}`);
  }

  /**
   * Ask the server to sign a transaction with one of its signers. The caller
   * must already be authenticated for an identity on the account.
   */
  signTransaction(
    address: string,
    signingAddress: string,
    transactionXdr: string
  ): Promise<Sep30Signature> {
    return this.request<Sep30Signature>(
      'POST',
      `/accounts/${address}/sign/${signingAddress}`,
      { transaction: transactionXdr }
    );
  }
}

/** One recovery server participating in a recovery, paired with its signer key. */
export type RecoveryServer = { client: Sep30Client; baseUrl: string; signerKey: string };

/** A signature collected from a recovery server, tagged with the signer it used. */
export type CollectedSignature = Sep30Signature & { signerKey: string; baseUrl: string };

/**
 * Collect signatures for a transaction from every supplied recovery server.
 *
 * Requests run concurrently. With `requireAll` (the default) a single failure
 * rejects; otherwise failures are skipped so an M-of-N threshold can still be
 * met by the servers that did answer.
 */
export async function collectRecoverySignatures(
  servers: RecoveryServer[],
  address: string,
  transactionXdr: string,
  opts: { requireAll?: boolean } = {}
): Promise<CollectedSignature[]> {
  const requireAll = opts.requireAll ?? true;

  const results = await Promise.allSettled(
    servers.map(async (server): Promise<CollectedSignature> => {
      const signature = await server.client.signTransaction(
        address,
        server.signerKey,
        transactionXdr
      );
      return { ...signature, signerKey: server.signerKey, baseUrl: server.baseUrl };
    })
  );

  const signatures: CollectedSignature[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') signatures.push(result.value);
    else if (requireAll) throw result.reason;
  }
  return signatures;
}

// ── Server configuration ──────────────────────────────────────────────────────

const RECOVERY_SERVERS_KEY = 'veil_recovery_servers';

/**
 * Parse a configured server list.
 *
 * Only `https` is accepted: a recovery server is asked to sign transactions
 * against the user's wallet, so a plaintext endpoint is not a server we are
 * willing to talk to. Duplicates and trailing slashes are normalised away.
 */
export function parseRecoveryServerUrls(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const candidate of raw.split(/[,\s]+/)) {
    const url = candidate.trim().replace(/\/+$/, '');
    if (url.startsWith('https://')) seen.add(url);
  }
  return [...seen];
}

/** Recovery servers baked into this build. */
export function getConfiguredRecoveryServers(): string[] {
  return parseRecoveryServerUrls(process.env['EXPO_PUBLIC_RECOVERY_SERVERS']);
}

/**
 * The recovery-key address configured for this build, if any.
 *
 * With a single recovery server this is just that server's signer key, which is
 * discovered from the server itself. It is configurable for the M-of-N case,
 * where the wallet's recovery key is a multisig account the servers are signers
 * on rather than any one server's own key.
 */
export function getConfiguredRecoveryAddress(): string {
  return process.env['EXPO_PUBLIC_RECOVERY_KEY_ADDRESS']?.trim() || '';
}

/** A deployed wallet contract address (`C…`). */
export function isValidWalletAddress(value: string): boolean {
  return StrKey.isValidContract(value.trim());
}

/** A Stellar account (`G…`) — what the contract's recovery key must be. */
export function isValidRecoveryAddress(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value.trim());
}

/**
 * Remember the server URLs so they can be rediscovered after device loss. The
 * URLs are not secret; tokens are never stored here.
 */
export async function rememberRecoveryServers(urls: string[]): Promise<void> {
  await AsyncStorage.setItem(RECOVERY_SERVERS_KEY, JSON.stringify(urls));
}

export async function getRememberedRecoveryServers(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(RECOVERY_SERVERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parseRecoveryServerUrls(parsed.join(',')) : [];
  } catch {
    return [];
  }
}

/** Every server this device knows about: remembered first, then this build's. */
export async function listRecoveryServerUrls(): Promise<string[]> {
  const remembered = await getRememberedRecoveryServers();
  return [...new Set([...remembered, ...getConfiguredRecoveryServers()])];
}

export type ResolvedRecoveryServers = {
  servers: RecoveryServer[];
  /** Servers that could not be used, with the reason, so the UI can say which. */
  failures: Array<{ baseUrl: string; message: string }>;
};

/**
 * Resolve each configured server into the signer it contributes to the account.
 *
 * A server that does not have the account registered, or that rejects the token,
 * is reported as a failure rather than throwing: recovery can still proceed on
 * the servers that did answer, and the user needs to see which ones did not.
 */
export async function resolveRecoveryServers(
  walletAddress: string,
  configs: RecoveryServerConfig[],
  fetchImpl: typeof fetch = fetch
): Promise<ResolvedRecoveryServers> {
  const servers: RecoveryServer[] = [];
  const failures: ResolvedRecoveryServers['failures'] = [];

  await Promise.all(
    configs.map(async (config) => {
      const client = new Sep30Client(config, fetchImpl);
      try {
        const account = await client.getAccount(walletAddress);
        const signerKey = account.signers?.[0]?.key;
        if (!signerKey) {
          failures.push({
            baseUrl: client.url,
            message: 'Server has no signer registered for this wallet.',
          });
          return;
        }
        servers.push({ client, baseUrl: client.url, signerKey });
      } catch (error) {
        failures.push({ baseUrl: client.url, message: describeError(error) });
      }
    })
  );

  return { servers, failures };
}

// ── The new signer ────────────────────────────────────────────────────────────

/**
 * Extract the 65-byte uncompressed P-256 point from a DER SubjectPublicKeyInfo.
 *
 * `create()` hands back the credential's public key as SPKI, while the wallet
 * contract stores signers as `BytesN<65>`. The point is the tail of the
 * structure, but the algorithm header is checked rather than trusted: a key on a
 * different curve would otherwise be silently truncated into 65 bytes and
 * registered as a signer that can never sign.
 */
export function spkiToUncompressedP256(spki: Uint8Array): Uint8Array {
  // OID 1.2.840.10045.2.1 (id-ecPublicKey) followed by 1.2.840.10045.3.1.7 (prime256v1).
  const P256_OIDS = [
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
    0x01, 0x07,
  ];

  const hasP256Oids = spki
    .subarray(0, Math.max(0, spki.length - 65))
    .join(',')
    .includes(P256_OIDS.join(','));

  const point = spki.subarray(spki.length - 65);
  if (spki.length < 65 + P256_OIDS.length || !hasP256Oids || point[0] !== 0x04) {
    throw new Error('Passkey did not return an uncompressed P-256 public key.');
  }

  return new Uint8Array(point);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** A freshly created device passkey, ready to be bound to the wallet. */
export type NewSigner = {
  /** Base64url credential id, stored so this device can select the passkey later. */
  credentialId: string;
  publicKey: Uint8Array;
  publicKeyHex: string;
};

function getRelyingPartyId(): string | undefined {
  return process.env['EXPO_PUBLIC_PASSKEY_RP_ID']?.trim() || undefined;
}

/**
 * Create a passkey on this device to serve as the wallet's new signer.
 *
 * Resolves to null when the user dismisses the sheet, so a decline reads as a
 * cancellation rather than a failure. Nothing is written to the keychain here —
 * the key only becomes this device's credential once the on-chain rotation has
 * actually completed.
 */
export async function createRecoverySigner(walletAddress: string): Promise<NewSigner | null> {
  if (!Passkeys.isSupported()) {
    throw new Error('Passkeys are not supported on this device.');
  }

  const created = await Passkeys.create({
    challenge: uint8ArrayToBase64Url(Crypto.getRandomBytes(32)),
    rp: { id: getRelyingPartyId(), name: 'Veil' },
    user: {
      id: uint8ArrayToBase64Url(Crypto.getRandomBytes(32)),
      name: walletAddress,
      displayName: 'Veil wallet',
    },
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    authenticatorSelection: {
      userVerification: 'required',
      residentKey: 'required',
      requireResidentKey: true,
    },
    timeout: 60_000,
  });

  if (!created) return null;

  const spki = created.response.getPublicKey();
  if (!spki) {
    throw new Error('This device did not return the new passkey public key.');
  }

  const publicKey = spkiToUncompressedP256(base64UrlToUint8Array(spki));
  return { credentialId: created.id, publicKey, publicKeyHex: toHex(publicKey) };
}

// ── Wallet contract reads ─────────────────────────────────────────────────────

/**
 * Read the wallet's current signers.
 *
 * Simulation only, so the throwaway source account needs no funding — and a
 * failure here is the earliest, cheapest signal that the address is wrong.
 */
export async function fetchWalletSigners(
  walletAddress: string,
  network: VeilNetwork = getNetwork()
): Promise<Uint8Array[]> {
  const server = new SorobanRpc.Server(network.rpcUrl);
  const source = new Account(Keypair.random().publicKey(), '0');

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(new Contract(walletAddress).call('get_signers'))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simulation)) {
    throw new Error('Could not read this wallet on-chain. Check the address and try again.');
  }

  const retval = simulation.result?.retval;
  if (!retval) throw new Error('No result from the wallet contract.');

  // get_signers returns Map<u32, BytesN<65>>; read the XDR directly rather than
  // through scValToNative, whose output shape varies by SDK version.
  try {
    return retval.map()?.map((entry) => new Uint8Array(entry.val().bytes())) ?? [];
  } catch {
    throw new Error('That contract does not look like a Veil wallet: it has no signer map.');
  }
}

/** Whether a public key is currently a signer on the wallet. */
export async function walletHasSigner(
  walletAddress: string,
  publicKey: Uint8Array,
  network: VeilNetwork = getNetwork()
): Promise<boolean> {
  const target = toHex(publicKey);
  const signers = await fetchWalletSigners(walletAddress, network);
  return signers.some((signer) => toHex(signer) === target);
}

// ── Recovery transactions ─────────────────────────────────────────────────────

/** The wallet contract's recovery timelock (`RECOVERY_KEY_DELAY`), in seconds. */
export const RECOVERY_TIMELOCK_SECONDS = 604_800;

/**
 * Build a recovery call on the wallet contract, sourced from the recovery-key
 * address so the servers' envelope signatures satisfy its `require_auth`.
 *
 * Returns assembled XDR: the Soroban footprint and resource fees are attached
 * here, because a signature covers the transaction exactly as submitted and
 * anything added afterwards would invalidate it.
 */
async function buildRecoveryCall(params: {
  walletAddress: string;
  recoveryAddress: string;
  method: string;
  args?: xdr.ScVal[];
  network: VeilNetwork;
}): Promise<string> {
  const server = new SorobanRpc.Server(params.network.rpcUrl);
  const source = await server.getAccount(params.recoveryAddress);

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: params.network.networkPassphrase,
  })
    .addOperation(new Contract(params.walletAddress).call(params.method, ...(params.args ?? [])))
    // Long enough for the round trip to every recovery server.
    .setTimeout(600)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simulation)) {
    throw new Error(simulationMessage(simulation.error));
  }

  return SorobanRpc.assembleTransaction(tx, simulation).build().toXDR();
}

/** Start the timelock that will bind `newSigner` to the wallet. */
export function buildRequestRecoveryTransaction(params: {
  walletAddress: string;
  recoveryAddress: string;
  newSigner: Uint8Array;
  network?: VeilNetwork;
}): Promise<string> {
  return buildRecoveryCall({
    walletAddress: params.walletAddress,
    recoveryAddress: params.recoveryAddress,
    method: 'request_recovery',
    args: [xdr.ScVal.scvBytes(Buffer.from(params.newSigner))],
    network: params.network ?? getNetwork(),
  });
}

/** Install the pending signer once the timelock has expired. */
export function buildFinalizeRecoveryTransaction(params: {
  walletAddress: string;
  recoveryAddress: string;
  network?: VeilNetwork;
}): Promise<string> {
  return buildRecoveryCall({
    walletAddress: params.walletAddress,
    recoveryAddress: params.recoveryAddress,
    method: 'finalize_recovery',
    network: params.network ?? getNetwork(),
  });
}

/**
 * Attach collected signatures to the transaction they were produced for.
 *
 * A signature issued for a different network is refused rather than attached: it
 * would be rejected on submission anyway, and a mismatch here means a
 * misconfigured server, which is worth saying out loud.
 */
export function attachRecoverySignatures(
  transactionXdr: string,
  signatures: CollectedSignature[],
  network: VeilNetwork = getNetwork()
): string {
  if (signatures.length === 0) {
    throw new Error('No recovery server signed the transaction.');
  }

  const tx = TransactionBuilder.fromXDR(transactionXdr, network.networkPassphrase);

  for (const signature of signatures) {
    if (
      signature.network_passphrase
      && signature.network_passphrase !== network.networkPassphrase
    ) {
      throw new Error(
        `${signature.baseUrl} signed for a different network (${signature.network_passphrase}).`
      );
    }
    tx.addSignature(signature.signerKey, signature.signature);
  }

  return tx.toXDR();
}

export type SubmittedRecovery = {
  hash: string;
  /** Ledger close time in unix seconds, when the RPC reported one. */
  closedAt: number | null;
};

/** Submit a signed recovery transaction and wait for the network to confirm it. */
export async function submitRecoveryTransaction(
  signedXdr: string,
  network: VeilNetwork = getNetwork()
): Promise<SubmittedRecovery> {
  const server = new SorobanRpc.Server(network.rpcUrl);
  const tx = TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase);

  const sent = await server.sendTransaction(tx);
  if (sent.status === 'ERROR') {
    throw new Error(
      `Transaction rejected: ${sent.errorResult?.toXDR('base64') ?? 'unknown reason'}`
    );
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await server.getTransaction(sent.hash);
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction failed on-chain: ${result.status}`);
      }
      return { hash: sent.hash, closedAt: result.createdAt ?? null };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error('Transaction timed out. Check the explorer before retrying.');
}

// ── Pending recovery, across app launches ─────────────────────────────────────

const PENDING_RECOVERY_KEY = 'veil_pending_recovery_v1';

/**
 * A recovery waiting out the contract's timelock.
 *
 * The new credential is held here rather than in the keychain until the rotation
 * completes: the device must remember which passkey it created (a week is a long
 * time), but it must not present it as the wallet's signer before the contract
 * says it is one.
 */
export type PendingRecovery = {
  walletAddress: string;
  recoveryAddress: string;
  credentialId: string;
  publicKeyHex: string;
  /** Unix seconds. */
  requestedAt: number;
  /** Unix seconds after which `finalize_recovery` is accepted. */
  unlockAt: number;
  txHash: string;
};

export async function savePendingRecovery(pending: PendingRecovery): Promise<void> {
  await AsyncStorage.setItem(PENDING_RECOVERY_KEY, JSON.stringify(pending));
}

export async function getPendingRecovery(): Promise<PendingRecovery | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_RECOVERY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingRecovery>;
    if (!parsed.walletAddress || !parsed.publicKeyHex || typeof parsed.unlockAt !== 'number') {
      return null;
    }
    return parsed as PendingRecovery;
  } catch {
    return null;
  }
}

export async function clearPendingRecovery(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_RECOVERY_KEY);
}

/** Whether the timelock on a pending recovery has elapsed. */
export function isRecoveryUnlocked(
  pending: PendingRecovery,
  now: number = Date.now() / 1000
): boolean {
  return now > pending.unlockAt;
}

// ── The flow ──────────────────────────────────────────────────────────────────

/**
 * Ask the recovery servers to start binding a new signer to the wallet.
 *
 * The servers sign the `request_recovery` transaction; this device never holds a
 * key that could authorize it alone. On success the pending recovery is
 * persisted, so the user can close the app and come back when the timelock is up.
 */
export async function requestSignerRebind(params: {
  walletAddress: string;
  recoveryAddress: string;
  servers: RecoveryServer[];
  signer: NewSigner;
  network?: VeilNetwork;
  requireAllServers?: boolean;
}): Promise<PendingRecovery> {
  const network = params.network ?? getNetwork();

  const unsignedXdr = await buildRequestRecoveryTransaction({
    walletAddress: params.walletAddress,
    recoveryAddress: params.recoveryAddress,
    newSigner: params.signer.publicKey,
    network,
  });

  const signatures = await collectRecoverySignatures(
    params.servers,
    params.walletAddress,
    unsignedXdr,
    { requireAll: params.requireAllServers ?? true }
  );

  const submitted = await submitRecoveryTransaction(
    attachRecoverySignatures(unsignedXdr, signatures, network),
    network
  );

  // Prefer the ledger's own close time over the device clock: the contract
  // measures the timelock in ledger time, and a wrong device clock would
  // otherwise show a finalize date the network will not honour.
  const requestedAt = submitted.closedAt ?? Math.floor(Date.now() / 1000);

  const pending: PendingRecovery = {
    walletAddress: params.walletAddress,
    recoveryAddress: params.recoveryAddress,
    credentialId: params.signer.credentialId,
    publicKeyHex: params.signer.publicKeyHex,
    requestedAt,
    unlockAt: requestedAt + RECOVERY_TIMELOCK_SECONDS,
    txHash: submitted.hash,
  };

  await savePendingRecovery(pending);
  await rememberRecoveryServers(params.servers.map((server) => server.baseUrl));

  return pending;
}

/**
 * Finalize a pending recovery and adopt the new signer on this device.
 *
 * `finalize_recovery` is permissionless on the contract, but the transaction
 * still needs a source account, so it is sourced from — and signed by — the same
 * recovery address. The keychain is only written after the network confirms the
 * rotation, and the pending record is cleared last so a failure part-way through
 * leaves something to retry from.
 */
export async function finalizeSignerRebind(params: {
  pending: PendingRecovery;
  servers: RecoveryServer[];
  network?: VeilNetwork;
  requireAllServers?: boolean;
}): Promise<{ hash: string }> {
  const network = params.network ?? getNetwork();
  const { pending } = params;

  const unsignedXdr = await buildFinalizeRecoveryTransaction({
    walletAddress: pending.walletAddress,
    recoveryAddress: pending.recoveryAddress,
    network,
  });

  const signatures = await collectRecoverySignatures(
    params.servers,
    pending.walletAddress,
    unsignedXdr,
    { requireAll: params.requireAllServers ?? true }
  );

  const submitted = await submitRecoveryTransaction(
    attachRecoverySignatures(unsignedXdr, signatures, network),
    network
  );

  await setWalletAddress(pending.walletAddress);
  await setPasskeyCredential(pending.credentialId, pending.publicKeyHex);
  await clearPendingRecovery();

  return { hash: submitted.hash };
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * The `WalletError` variants this flow can hit (contracts/invisible_wallet), in
 * words that tell the user what to do rather than which discriminant fired.
 */
const CONTRACT_ERRORS: Record<number, string> = {
  13: 'A recovery is already pending on this wallet. Wait for it to finish, or cancel it from the device that still has access.',
  14: 'There is no pending recovery on this wallet to finalize.',
  15: 'The recovery timelock has not expired yet. Come back after the unlock date.',
  22: 'This wallet has no recovery key set, so server-assisted recovery is not available for it.',
};

/** Turn a simulation failure into something a user can act on. */
export function simulationMessage(error: string): string {
  const code = /Error\(Contract, #(\d+)\)/.exec(error)?.[1];
  const known = code ? CONTRACT_ERRORS[Number(code)] : undefined;
  return known ?? `Simulation failed: ${error}`;
}

export function describeError(error: unknown): string {
  if (error instanceof Sep30Error) return `${error.message} (HTTP ${error.status})`;
  if (error instanceof Error) return error.message;
  return String(error);
}
