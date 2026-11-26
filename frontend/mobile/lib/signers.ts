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
 * Raised by {@link readSigners} when the RPC answered but no `get_signers`
 * instance exists at the address. Distinct from the network being unreachable,
 * which surfaces as whatever the RPC threw instead — callers catch this type
 * to tell the two apart.
 */
export class WalletContractNotFoundError extends Error {
  readonly contractAddress: string;

  constructor(contractAddress: string) {
    super(`No wallet contract is deployed at ${contractAddress} on this network.`);
    this.name = 'WalletContractNotFoundError';
    this.contractAddress = contractAddress;
  }
}

/**
 * Simulation diagnostics that mean "there is no contract here" rather than
 * "the call failed". Anything else coming back as a simulation error is left
 * to the caller to show — and a thrown fetch/SDK failure is not even this, so
 * network trouble never reads as a missing wallet.
 */
const CONTRACT_MISSING_RE = /MissingValue|not found|does not exist|no such|missing contract|contract wasm/i;

/**
 * The signers registered on a wallet contract, lowest index first.
 *
 * Throws {@link WalletContractNotFoundError} when the contract is not deployed,
 * and whatever the RPC layer throws when the network is unreachable — callers
 * catch the former to say "no wallet here" and anything else to say "couldn't
 * reach the network".
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
    if (CONTRACT_MISSING_RE.test(sim.error)) {
      throw new WalletContractNotFoundError(contractAddress);
    }
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
