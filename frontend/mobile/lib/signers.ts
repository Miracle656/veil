/**
 * Reading the wallet contract's registered signers.
 *
 * The SDK has a `getSigners()`, but it reads the wallet address out of the SDK
 * hook's own in-memory state, which is only populated by `register()` or
 * `login()` during that session. Mobile keeps the address in walletStore and
 * never hydrates the SDK, so calling it throws "No wallet address. Call
 * register() or login() first." on a wallet that plainly exists.
 *
 * `get_signers` is a read-only contract call, so this simulates it against the
 * address we already have. No keys, no passkey prompt, no SDK state.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc as SorobanRpc,
  scValToNative,
} from '@stellar/stellar-sdk';

import { getNetwork } from './network';

export type WalletSigner = {
  /** The signer's slot in the contract's signer map. */
  index: number;
  /** Uncompressed P-256 public key, lowercase hex. */
  publicKey: string;
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The signers registered on a wallet contract, lowest index first.
 *
 * Throws when the contract cannot be reached or is not deployed — callers
 * should check deployment first so they can say which of the two it was.
 */
export async function readSigners(contractAddress: string): Promise<WalletSigner[]> {
  const network = getNetwork();
  const server = new SorobanRpc.Server(network.rpcUrl);

  // A simulation is never submitted, so the source account only has to be
  // well-formed — it is not charged and its sequence is never consumed.
  const source = new Account(Keypair.random().publicKey(), '0');
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(new Contract(contractAddress).call('get_signers'))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }

  const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result;
  if (!result) return [];

  // The contract returns Map<u32, BytesN<65>>; scValToNative gives a JS Map on
  // some versions and a plain object on others, so handle both.
  const native = scValToNative(result.retval);
  const entries: [unknown, unknown][] =
    native instanceof Map
      ? Array.from(native.entries())
      : Object.entries((native ?? {}) as Record<string, unknown>);

  return entries
    .map(([index, key]) => ({
      index: typeof index === 'string' ? Number.parseInt(index, 10) : Number(index),
      publicKey: key instanceof Uint8Array ? toHex(key) : String(key),
    }))
    .filter((signer) => Number.isFinite(signer.index))
    .sort((a, b) => a.index - b.index);
}
