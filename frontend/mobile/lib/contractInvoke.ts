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
import { signAndSubmitSorobanXdr } from './sorobanTx';
import { signXdrPayload } from './walletConnect';
import { getSignerSecret } from './walletStore';

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
 * Invoke `method(...args)` on `contractId` as the spending account itself.
 *
 * A classic account authorises a Soroban call with its ordinary signature, so
 * there is no passkey prompt and no `__check_auth`. The web wallet buys names
 * and figures this way for a wallet whose passkey it cannot use, which leaves
 * the name on the spending account; anything gated on that name then has to be
 * bought by the same account, on the phone as well.
 *
 * `expected` is the account the caller read the gate and the balance for. If
 * the key on this device is no longer that account, nothing is sent: the
 * numbers on screen were about somebody else.
 */
export async function invokeAsSpendingAccount(
  expected: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  flow: string,
): Promise<string> {
  const secret = await getSignerSecret();
  if (!secret) throw new Error('No spending account on this device yet.');
  if (Keypair.fromSecret(secret).publicKey() !== expected) {
    throw new Error(
      'The spending account on this device has changed. Reopen this screen and try again.',
    );
  }

  const network = getNetwork();
  // Only a carrier for the operation. `signAndSubmitSorobanXdr` lifts it into a
  // transaction on a fresh sequence number and simulates that before signing.
  const carrier = new TransactionBuilder(new Account(expected, '0'), {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(120)
    .build();

  return signAndSubmitSorobanXdr({
    xdr: carrier.toXDR(),
    signerSecret: secret,
    rpcUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
    horizonUrl: network.horizonUrl,
    flow,
  });
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
