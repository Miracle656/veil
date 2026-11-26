/**
 * Reading a value out of a Soroban contract without spending anything.
 *
 * Simulation runs the contract and returns what it would have returned, so a
 * getter costs one RPC round trip and no transaction. Both the names registry
 * and the Masquerade collection are read this way, and they were about to grow
 * a copy each — two copies of a function whose entire job is deciding what
 * counts as "could not read" is two different answers to that question.
 */

import {
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
} from '@stellar/stellar-sdk'

import { inclusionFee } from './fees'

/**
 * A simulation-only source account. Never signs, never needs to exist.
 *
 * Simulation does not check the source, so a random key is fine and avoids
 * making every read depend on some particular account being funded.
 */
export function probeAccount(): Account {
  return new Account(Keypair.random().publicKey(), '0')
}

/**
 * Simulate `method(...args)` on `contractId` and return the native value.
 *
 * **Null means "could not read", never "the answer is nothing."** A transport
 * failure, a missing contract and a contract that panicked all land here, and
 * callers must not collapse that into a confident answer: showing *no USDC*
 * because an RPC call failed sends someone to top up an account that is
 * already funded, and showing *available* for a name that is taken costs
 * somebody money.
 */
export async function simulateRead(
  rpc: SorobanRpc.Server,
  contractId: string,
  method: string,
  args: ReturnType<typeof nativeToScVal>[],
  networkPassphrase: string,
): Promise<unknown | null> {
  try {
    const tx = new TransactionBuilder(probeAccount(), {
      fee: inclusionFee(),
      networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) return null
    const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
    if (!result?.retval) return null
    return scValToNative(result.retval)
  } catch {
    return null
  }
}
