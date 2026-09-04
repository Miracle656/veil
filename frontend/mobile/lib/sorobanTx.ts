import { Transaction, TransactionBuilder, Keypair, rpc as SorobanRpc } from '@stellar/stellar-sdk';

import './polyfills';
import { assertRoundTrips, simulationErrorMessage } from './simulationError';
import { inclusionFee } from './fees';

/**
 * Sign a Soroban transaction XDR with the fee-payer key and submit it over RPC.
 *
 * The incoming XDR (e.g. from Soroswap's build endpoint) is treated as an
 * OPERATION carrier, not a finished envelope: upstream builders can hand back
 * a stale sequence number (their view lags right after another transaction
 * from the same account, e.g. the trustline opened moments earlier → txBadSeq
 * with zero fee charged) and a 100-stroop inclusion bid that mainnet surge
 * pricing rejects. So the operations are lifted into a locally-built
 * transaction: fresh sequence from the SAME RPC that will receive it, our
 * network-aware inclusion bid, and resources re-simulated from scratch.
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

  const upstream = TransactionBuilder.fromXDR(params.xdr, params.networkPassphrase);
  if (!(upstream instanceof Transaction)) {
    throw new Error('Fee-bump envelopes are not supported here.');
  }

  const source = await rpc.getAccount(upstream.source);
  const builder = new TransactionBuilder(source, {
    fee: inclusionFee(),
    networkPassphrase: params.networkPassphrase,
  });
  // Copy the raw XDR operations — this preserves the invocation and its auth
  // entries (source-account credentials stay valid: same source account).
  // v17: TransactionEnvelope is a discriminated union, so the v1 arm is a
  // property reached after narrowing rather than an accessor. A fee-bump
  // envelope was already rejected above, and a v0 envelope cannot carry a
  // Soroban invocation, so anything else here is not something to copy.
  const envelope = upstream.toEnvelope();
  if (envelope.type !== 'envelopeTypeTx') {
    throw new Error(`Unsupported transaction envelope: ${envelope.type}`);
  }
  for (const op of envelope.v1.tx.operations) {
    builder.addOperation(op);
  }
  builder.addMemo(upstream.memo);
  builder.setTimeout(120);
  const built = builder.build();

  // The footprint and resource fees have to be assembled before submit; the
  // simulation also revalidates the invocation against the current ledger.
  const encoded = built.toXDR();
  assertRoundTrips(encoded, params.networkPassphrase, 'Swap');

  const sim = await rpc.simulateTransaction(built);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(
      simulationErrorMessage({
        error: sim.error,
        flow: 'Swap',
        rpcUrl: params.rpcUrl,
        network: params.networkPassphrase.includes('Test') ? 'testnet' : 'mainnet',
        xdrLength: encoded.length,
      }),
    );
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
