import { Keypair, TransactionBuilder, rpc as SorobanRpc } from '@stellar/stellar-sdk'
import { buildSponsoredFeeBumpTransaction } from './feeBump'

/**
 * Sign a Soroban transaction XDR with the fee-payer key and submit via RPC.
 * Returns the transaction hash when the network confirms success.
 */
export async function signAndSubmitSorobanXdr(params: {
  xdr: string
  signerSecret: string
  rpcUrl: string
  networkPassphrase: string
  sponsorSecret?: string
}): Promise<string> {
  const rpc = new SorobanRpc.Server(params.rpcUrl)
  const signer = Keypair.fromSecret(params.signerSecret)

  const built = TransactionBuilder.fromXDR(params.xdr, params.networkPassphrase)

  // Ensure Soroban footprint/resources are assembled before submit.
  const sim = await rpc.simulateTransaction(built)
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`)
  }

  const assembled = SorobanRpc.assembleTransaction(built, sim).build()
  assembled.sign(signer)
  const submission = params.sponsorSecret
    ? buildSponsoredFeeBumpTransaction({
        innerTransaction: assembled,
        networkPassphrase: params.networkPassphrase,
        sponsor: { secret: params.sponsorSecret },
      })
    : assembled

  const sendResult = await rpc.sendTransaction(submission)
  if (sendResult.status === 'ERROR') {
    throw new Error(
      `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`
    )
  }

  for (let i = 0; i < 30; i++) {
    const result = await rpc.getTransaction(sendResult.hash)
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction failed: ${result.status}`)
      }
      return sendResult.hash
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error('Transaction timed out - check status manually')
}
