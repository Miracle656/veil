/**
 * Sweep a Soroban wallet contract's (C...) native XLM balance to a classic
 * (G...) fee-payer account, so the funds can be paid to a SEP-24 anchor's
 * withdrawal address.
 *
 * Ported from frontend/wallet/lib/sweepContractBalance.ts. The wallet
 * version signs Soroban auth entries with a browser WebAuthn passkey
 * (crypto.subtle digests + navigator.credentials.get), none of which is
 * available on React Native. The on-chain, RPC-only pieces — reading the
 * contract's SAC balance and simulating the transfer — are ported as-is
 * (they only use fetch under the hood, via @stellar/stellar-sdk's RPC
 * client). Building, signing and submitting the transfer transaction is
 * delegated to an injectable `signAndSubmit` callback, mirroring the
 * `submitBatch` pattern in lib/bulkPayout.ts — the screen can pass a stub
 * today since mobile has no signing infra ported yet.
 */

import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
} from '@stellar/stellar-sdk';

export interface SweepParams {
  /** The C... Soroban wallet contract address to sweep from. */
  contractAddress: string;
  /** The G... classic account that will receive the swept balance. */
  feePayerPublicKey: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export interface SweepResult {
  /** Submitted transaction hash. */
  hash: string;
  /** Amount swept, in stroops (as a decimal string). */
  amountStroops: string;
}

/**
 * Given a built (unsigned) sweep transaction and the amount it moves, sign
 * whatever auth is required (Soroban auth entries + fee-payer signature)
 * and submit it to the network. Returns the submitted transaction hash.
 */
export type SweepSigner = (params: {
  contractAddress: string;
  feePayerPublicKey: string;
  amountStroops: bigint;
  rpcUrl: string;
  networkPassphrase: string;
}) => Promise<{ hash: string }>;

/**
 * Reads the contract's native XLM (SAC) balance via a throw-away simulation
 * account — no signature or funds required, matches the wallet's step 1.
 */
export async function getContractBalance(
  contractAddress: string,
  rpcUrl: string,
  networkPassphrase: string,
): Promise<bigint> {
  const rpc = new SorobanRpc.Server(rpcUrl);
  const sacId = Asset.native().contractId(networkPassphrase);
  const sac = new Contract(sacId);

  const dummyKp = Keypair.random();
  const dummyAcct = new Account(dummyKp.publicKey(), '0');
  const balanceTx = new TransactionBuilder(dummyAcct, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(sac.call('balance', nativeToScVal(contractAddress, { type: 'address' })))
    .setTimeout(30)
    .build();

  const balanceSim = await rpc.simulateTransaction(balanceTx);
  if (SorobanRpc.Api.isSimulationError(balanceSim)) {
    throw new Error(`Balance check failed: ${balanceSim.error}`);
  }

  const balResult = (balanceSim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result;
  if (!balResult) throw new Error('No balance result from simulation');

  return scValToNative(balResult.retval) as bigint;
}

/**
 * Sweeps the full native (XLM) balance out of the wallet contract into the
 * classic fee-payer account. Throws if the contract balance is zero, or if
 * `signAndSubmit` fails / is cancelled.
 */
export async function sweepContractBalance(
  params: SweepParams,
  signAndSubmit: SweepSigner,
): Promise<SweepResult> {
  const { contractAddress, feePayerPublicKey, rpcUrl, networkPassphrase } = params;

  const amountStroops = await getContractBalance(contractAddress, rpcUrl, networkPassphrase);
  if (amountStroops <= 0n) {
    throw new Error('Contract balance is zero — nothing to sweep');
  }

  const { hash } = await signAndSubmit({
    contractAddress,
    feePayerPublicKey,
    amountStroops,
    rpcUrl,
    networkPassphrase,
  });

  return { hash, amountStroops: amountStroops.toString() };
}
