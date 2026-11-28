/**
 * Veil Connect: preparing and making a contract call another app asked for.
 *
 * Two steps, and the second repeats the first on purpose:
 *
 *  1. `previewInvoke` simulates the call and reads what it would have the
 *     person approve (lib/connectInvoke.ts). Nothing is signed.
 *  2. `runInvoke` makes the call through the wallet's one signing path
 *     (lib/walletInvoke.ts). That path simulates again, and the result is read
 *     again and compared with what was shown. A contract whose behaviour
 *     changed in between is refused before the passkey is asked for anything.
 *
 * The transaction is built here from a contract id, a function name and typed
 * arguments. An app never supplies a transaction for Veil to sign.
 */
import {
  Asset,
  Contract,
  TransactionBuilder,
  rpc as SorobanRpc,
} from '@stellar/stellar-sdk'

import type { ConnectRequest } from './connect'
import { invokeArgsToScVals, readAuthEntries, type Approval, type AuthContext, type Movement } from './connectInvoke'
import { inclusionFee } from './fees'
import { getNetwork, getUsdcIssuer } from './network'
import { requirePasskey } from './passkeyAuth'
import { buildSignAuthEntry, getFeePayerKeypair } from './passkeySigner'
import { getDeploymentState } from './walletDeployment'
import { invokeAsWallet } from './walletInvoke'

export type InvokeRequest = Extract<ConnectRequest, { type: 'invoke' }>

export type InvokePreview = {
  approvals: Approval[]
  movements: Movement[]
  digest: string
  /** The network's charge for the call, in XLM, as the simulation estimates it. */
  feeXlm: string
  /** The spending account (G…) that carries the transaction. */
  spending: string
}

/** A sentence the person can act on. Nothing was signed when this is thrown. */
export class InvokeRefused extends Error {}

function authContext(wallet: string, spending: string): AuthContext {
  const { networkPassphrase } = getNetwork()
  const knownTokens: Record<string, string> = {
    [Asset.native().contractId(networkPassphrase)]: 'XLM',
  }
  try {
    knownTokens[new Asset('USDC', getUsdcIssuer()).contractId(networkPassphrase)] = 'USDC'
  } catch {
    // USDC is not set up on this network: its contract is then shown by id.
  }
  return { wallet, spending, knownTokens }
}

/** Simulate the call and read what it asks the person to approve. Signs nothing. */
export async function previewInvoke(request: InvokeRequest, wallet: string): Promise<InvokePreview> {
  const network = getNetwork()
  const feePayer = getFeePayerKeypair()
  const rpc = new SorobanRpc.Server(network.rpcUrl)

  let account
  try {
    account = await rpc.getAccount(feePayer.publicKey())
  } catch {
    throw new InvokeRefused(
      'Your spending account has no XLM yet, so it cannot pay the network fee. Add a little XLM in Veil, then try again.',
    )
  }

  const tx = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(new Contract(request.contract).call(request.method, ...invokeArgsToScVals(request.args)))
    .setTimeout(30)
    .build()

  const sim = await rpc.simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(sim)) {
    // The contract refused, or the function or its arguments are wrong. The
    // raw text is long and technical; the first line is the useful part.
    const first = String(sim.error).split('\n')[0].slice(0, 200)
    throw new InvokeRefused(`The contract would not accept this call, so nothing was sent. (${first})`)
  }
  const ok = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse

  const reading = readAuthEntries(ok.result?.auth ?? [], authContext(wallet, feePayer.publicKey()))
  if (!reading.ok) throw new InvokeRefused(reading.reason)

  // A call the wallet must approve needs the wallet to exist on chain.
  if (reading.approvals.some((a) => a.signer === 'wallet') && (await getDeploymentState(wallet)) === 'undeployed') {
    throw new InvokeRefused('Your wallet is not fully set up yet. Open your Veil dashboard once, then try again.')
  }

  const stroops = BigInt(ok.minResourceFee ?? '0') + BigInt(inclusionFee())
  const feeXlm = (Number(stroops) / 1e7).toFixed(7).replace(/0+$/, '').replace(/\.$/, '')

  return {
    approvals: reading.approvals,
    movements: reading.movements,
    digest: reading.digest,
    feeXlm,
    spending: feePayer.publicKey(),
  }
}

/**
 * Make the call the person approved. `digest` is the one from the preview they
 * were shown; a call that no longer reads the same is refused unsigned.
 */
export async function runInvoke(
  request: InvokeRequest,
  wallet: string,
  preview: Pick<InvokePreview, 'digest' | 'approvals'>,
): Promise<{ hash: string; result: string | null; spending: string }> {
  const network = getNetwork()
  const feePayer = getFeePayerKeypair()
  const ctx = authContext(wallet, feePayer.publicKey())

  // The wallet's own approval is a passkey prompt per tree. A call that only
  // the spending account approves would otherwise go out on a stored key
  // alone, so the passkey is asked for here instead.
  if (!preview.approvals.some((a) => a.signer === 'wallet')) await requirePasskey()

  const hash = await invokeAsWallet({
    contractId: request.contract,
    method: request.method,
    args: invokeArgsToScVals(request.args),
    walletAddress: wallet,
    feePayerKeypair: feePayer,
    signAuthEntry: buildSignAuthEntry(),
    rpcUrl: network.rpcUrl,
    networkPassphrase: network.networkPassphrase,
    label: 'connect-invoke',
    checkAuthEntries: (entries) => {
      const again = readAuthEntries(entries, ctx)
      if (!again.ok) throw new InvokeRefused(again.reason)
      if (again.digest !== preview.digest) {
        throw new InvokeRefused(
          'What this call would do changed while you were reading it, so nothing was sent. Close this window and start again.',
        )
      }
    },
  })

  // What the contract returned, for the app. Never the reason a call that
  // already succeeded is reported as failed.
  let result: string | null = null
  try {
    const done = await new SorobanRpc.Server(network.rpcUrl).getTransaction(hash)
    if (done.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS && done.returnValue) {
      result = done.returnValue.toXDR('base64')
    }
  } catch {
    result = null
  }

  return { hash, result, spending: feePayer.publicKey() }
}
