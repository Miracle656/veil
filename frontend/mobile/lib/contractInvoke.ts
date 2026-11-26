/**
 * Calling any contract as the smart wallet — the `__check_auth` path.
 *
 * `lib/contractSpend.ts` has done this for SAC transfers since the wallet could
 * spend at all, and the sequence is not specific to transfers: build the call
 * against the fee-payer's account, let `signXdrPayload` run the ceremony
 * (recording-mode simulate, passkey-sign each auth entry, enforce-mode
 * re-simulate, fee-payer wrap), submit, poll.
 *
 * It lives here on its own because two more callers now want it — buying a
 * Veil name and buying a Masquerade figure — and the alternative was three
 * copies of the one sequence in this codebase that is genuinely hard to get
 * right. `sendAssetFromContract` is now one of the three.
 */

import { Account, Contract, Keypair, TransactionBuilder, rpc as SorobanRpc, xdr } from '@stellar/stellar-sdk';

import { getFeePayerAddress } from './activity';
import { inclusionFee } from './fees';
import { getNetwork } from './network';
import { rejectionFromResult } from './networkErrors';
import { registerPasskeySigner } from './passkey';
import { pollForResult } from './sendPayment';
import { signXdrPayload } from './walletConnect';

/**
 * Invoke `method(...args)` on `contractId`, authorised by the wallet's passkey.
 *
 * Resolves with the transaction hash. Prompts for the passkey, so never call it
 * speculatively — a prompt the user did not ask for teaches them to dismiss
 * prompts.
 */
export async function invokeAsWallet(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string> {
  const network = getNetwork();
  const server = new SorobanRpc.Server(network.rpcUrl);

  const feePayer = await getFeePayerAddress();
  if (!feePayer) throw new Error('No fee-payer key on this device.');

  const account = await server.getAccount(feePayer);
  const unsigned = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();

  const unregister = registerPasskeySigner();
  try {
    const signedXdr = await signXdrPayload(unsigned.toXDR());
    const signedTx = TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase);
    const sendResult = await server.sendTransaction(signedTx);
    if (sendResult.status === 'ERROR') {
      throw new Error(rejectionFromResult(sendResult.errorResult));
    }
    return await pollForResult(server, sendResult.hash);
  } finally {
    unregister();
  }
}

/**
 * Read a contract's return value by simulating a call.
 *
 * **Null means "could not read", never "the answer is nothing."** A transport
 * failure, a missing contract and a contract that panicked all land here. The
 * web wallet learned this the expensive way: collapsing the three told a funded
 * wallet it was broke and told buyers a free name was taken.
 */
export async function simulateRead(
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<unknown | null> {
  try {
    const network = getNetwork();
    const server = new SorobanRpc.Server(network.rpcUrl);

    // Simulation does not check the source account, so any address serves and
    // none of this needs a funded account. It must not need the FEE-PAYER
    // either: requiring one meant a phone with no wallet yet could not read
    // the Veil-ians grid at all, and the screen reported that as "could not
    // read which pieces are available" — a browse blocked by a signing key it
    // was never going to use.
    const probe = Keypair.random().publicKey();
    const account = new Account(probe, '0');

    const tx = new TransactionBuilder(account, {
      fee: inclusionFee(),
      networkPassphrase: network.networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) return null;
    const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result;
    if (!result?.retval) return null;
    const { scValToNative } = await import('@stellar/stellar-sdk');
    return scValToNative(result.retval);
  } catch {
    return null;
  }
}
