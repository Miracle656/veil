import {
  Account,
  Asset,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
} from '@stellar/stellar-sdk'
import type { WebAuthnSignature } from '@veil/sdk'

import { inclusionFee } from './fees'
import { invokeAsWallet } from './walletInvoke'

/**
 * Sweeps the full XLM balance from the `C…` contract's SAC account to the `G…`
 * fee-payer. The contract authorises the transfer via a WebAuthn passkey,
 * which triggers `__check_auth`. Returns the submitted transaction hash.
 *
 * The signing and submission sequence lives in `./walletInvoke.ts` — it is the
 * same seven steps for every contract call the wallet authorises, and the
 * nonce handling and enforce-mode re-simulation are too easy to get subtly
 * wrong in a second copy.
 *
 * Throws if:
 *   - Contract SAC balance is zero (nothing to sweep)
 *   - Simulation fails
 *   - `signAuthEntry` returns null (user cancelled the passkey prompt)
 *   - Transaction is rejected or times out
 */
export async function sweepContractBalance(
  contractAddress: string,
  feePayerKeypair: Keypair,
  signAuthEntry: (payload: Uint8Array) => Promise<WebAuthnSignature | null>,
  rpcUrl: string,
  networkPassphrase: string,
): Promise<string> {
  const rpc = new SorobanRpc.Server(rpcUrl)
  const sacId = Asset.native().contractId(networkPassphrase)
  const sac = new Contract(sacId)

  // Read the C… SAC balance with a throw-away account; this is simulation
  // only, so the account never needs to exist or hold anything.
  const dummyKp = Keypair.random()
  const dummyAcct = new Account(dummyKp.publicKey(), '0')
  const balanceTx = new TransactionBuilder(dummyAcct, {
    fee: inclusionFee(),
    networkPassphrase,
  })
    .addOperation(sac.call('balance', nativeToScVal(contractAddress, { type: 'address' })))
    .setTimeout(30)
    .build()

  const balanceSim = await rpc.simulateTransaction(balanceTx)
  if (SorobanRpc.Api.isSimulationError(balanceSim)) {
    throw new Error(`Balance check failed: ${balanceSim.error}`)
  }

  const balResult = (balanceSim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
  if (!balResult) throw new Error('No balance result from simulation')

  const balanceStroops = scValToNative(balResult.retval) as bigint
  if (balanceStroops <= 0n) {
    throw new Error('Contract balance is zero — nothing to sweep')
  }

  return invokeAsWallet({
    contractId: sacId,
    method: 'transfer',
    args: [
      nativeToScVal(contractAddress, { type: 'address' }),
      nativeToScVal(feePayerKeypair.publicKey(), { type: 'address' }),
      nativeToScVal(balanceStroops, { type: 'i128' }),
    ],
    walletAddress: contractAddress,
    feePayerKeypair,
    signAuthEntry,
    rpcUrl,
    networkPassphrase,
    label: 'sweep',
  })
}
