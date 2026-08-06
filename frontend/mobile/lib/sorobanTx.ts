import { Keypair, TransactionBuilder, rpc as SorobanRpc } from '@stellar/stellar-sdk';

import './polyfills';

/**
 * Sign a Soroban transaction XDR with the fee-payer key and submit it over RPC.
 *
 * Ported from `frontend/wallet/lib/sorobanTx.ts`. The sponsored fee-bump branch
 * is left out: mobile has no fee-bump helper yet, and every caller here pays its
 * own fee.
 *
 * Resolves with the transaction hash once the network reports success.
 */
export async function signAndSubmitSorobanXdr(params: {
  xdr: string;
  signerSecret: string;
  rpcUrl: string;
  networkPassphrase: string;
}): Promise<string> {
  const rpc = new SorobanRpc.Server(params.rpcUrl);
  const signer = Keypair.fromSecret(params.signerSecret);

  const built = TransactionBuilder.fromXDR(params.xdr, params.networkPassphrase);

  // The footprint and resource fees have to be assembled before submit, and the
  // XDR may have been built before the ledger moved on.
  const sim = await rpc.simulateTransaction(built);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  const assembled = SorobanRpc.assembleTransaction(built, sim).build();
  assembled.sign(signer);

  const sendResult = await rpc.sendTransaction(assembled);
  if (sendResult.status === 'ERROR') {
    throw new Error(
      `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`
    );
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await rpc.getTransaction(sendResult.hash);
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction failed: ${result.status}`);
      }
      return sendResult.hash;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error('Transaction timed out — check its status manually');
}
