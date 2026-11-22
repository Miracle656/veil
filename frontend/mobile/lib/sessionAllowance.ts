import { Asset, Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';

import { invokeAsWallet } from './contractInvoke';
import { getNetwork } from './network';
import { getAgentUrl } from './agentClient';

export type SessionAllowance = {
  keyId: string;
  publicKey: string;
  targetContract: string;
  selector: string;
  cap: bigint;
  spent: bigint;
  expiry: bigint;
};

export type SessionAllowanceRead = SessionAllowance | null;

/** Ask the assistant service for its public session key. The response is never trusted for limits. */
export async function requestSessionPublicKey(
  walletAddress: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const configured = process.env['EXPO_PUBLIC_AGENT_SESSION_KEY_URL']?.trim();
  const url = configured || `${getAgentUrl().replace(/\/$/, '')}/session-key`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ walletAddress }),
  });
  if (!response.ok) throw new Error(`Could not get the assistant key (HTTP ${response.status})`);
  const body = (await response.json()) as { publicKey?: unknown };
  if (typeof body.publicKey !== 'string') throw new Error('The assistant did not return a public key.');
  const value = body.publicKey.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Uint8Array.from(Buffer.from(value, 'hex'));
  try {
    const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
    if (bytes.length === 32) return bytes;
  } catch {
    // fall through to the stable validation error
  }
  throw new Error('The assistant returned an invalid public key.');
}

/** The public storage handle is not secret; the private key never enters this app. */
export function sessionKeyId(publicKey: Uint8Array): Uint8Array {
  return sha256(publicKey);
}

function i128(value: xdr.ScVal): bigint {
  const parts = value.i128();
  return (BigInt(parts.hi().toString()) << 64n) | BigInt(parts.lo().toString());
}

/** #[contracttype] enum SessionDataKey::Acl(BytesN<32>) */
export function sessionAllowanceLedgerKey(wallet: string, keyId: Uint8Array): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(wallet).toScAddress(),
      key: xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('Acl'),
        xdr.ScVal.scvBytes(Buffer.from(keyId)),
      ]),
      durability: xdr.ContractDataDurability.temporary(),
    }),
  );
}

export function decodeSessionAllowance(value: xdr.ScVal, keyId: Uint8Array): SessionAllowance {
  const fields = new Map<string, xdr.ScVal>();
  for (const entry of value.map() ?? []) fields.set(entry.key().sym().toString(), entry.val());
  const pubkey = fields.get('pubkey')?.bytes();
  const target = fields.get('target_contract');
  const selector = fields.get('selector');
  const cap = fields.get('amount_cap');
  const spent = fields.get('spent');
  const expiry = fields.get('expiry');
  if (!pubkey || !target || !selector || !cap || !spent || !expiry) {
    throw new Error('Session allowance entry is incomplete');
  }
  return {
    keyId: Buffer.from(keyId).toString('hex'),
    publicKey: Buffer.from(pubkey).toString('hex'),
    targetContract: Address.fromScVal(target).toString(),
    selector: selector.sym().toString(),
    cap: i128(cap),
    spent: i128(spent),
    expiry: BigInt(expiry.u64().toString()),
  };
}

/** Read the deployed contract's temporary ACL record; RPC failure is thrown. */
export async function readSessionAllowance(
  wallet: string,
  publicKey: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionAllowanceRead> {
  const keyId = sessionKeyId(publicKey);
  const key = sessionAllowanceLedgerKey(wallet, keyId).toXDR('base64');
  const response = await fetchImpl(getNetwork().rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys: [key] } }),
  });
  if (!response.ok) throw new Error(`Could not read the allowance (RPC returned HTTP ${response.status})`);
  const body = (await response.json()) as { error?: { message?: string }; result?: { entries?: Array<{ xdr: string }> } };
  if (body.error) throw new Error(`Could not read the allowance: ${body.error.message ?? 'RPC error'}`);
  const entry = body.result?.entries?.[0];
  if (!entry) return null;
  return decodeSessionAllowance(xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64').contractData().val(), keyId);
}

export async function registerSessionAllowance(
  wallet: string,
  publicKey: Uint8Array,
  amount: bigint,
  expiry: bigint,
): Promise<string> {
  if (publicKey.length !== 32) throw new Error('The assistant supplied an invalid session key.');
  if (amount <= 0n) throw new Error('Allowance must be greater than zero.');
  if (expiry <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('End date must be in the future.');
  const network = getNetwork();
  const tokenContract = new Asset(
    'USDC',
    network.name === 'mainnet'
      ? 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
      : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  ).contractId(network.networkPassphrase);
  const keyId = sessionKeyId(publicKey);
  return invokeAsWallet(wallet, 'register_session_key', [
    xdr.ScVal.scvBytes(Buffer.from(publicKey)),
    xdr.ScVal.scvBytes(Buffer.from(keyId)),
    new Address(tokenContract).toScVal(),
    xdr.ScVal.scvSymbol('transfer'),
    nativeToScVal(amount, { type: 'i128' }),
    xdr.ScVal.scvU64(xdr.Uint64.fromString(expiry.toString())),
  ]);
}

export function revokeSessionAllowance(wallet: string, publicKey: Uint8Array): Promise<string> {
  return invokeAsWallet(wallet, 'revoke_session_key', [xdr.ScVal.scvBytes(Buffer.from(sessionKeyId(publicKey)))]);
}
