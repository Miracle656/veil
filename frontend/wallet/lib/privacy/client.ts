import { Keypair, Transaction, rpc as SorobanRpc } from '@stellar/stellar-sdk'
import { buildSponsoredFeeBumpTransaction } from '../feeBump'
import * as Sentry from '@sentry/nextjs'

export async function submitPrivateTransaction(params: {
  innerTx: Transaction
  sponsorSecret: string
  rpcUrl: string
  networkPassphrase: string
}): Promise<string> {
  const rpc = new SorobanRpc.Server(params.rpcUrl)
  const signer = Keypair.fromSecret(params.sponsorSecret)

  // 1. Sponsor the private transaction fees like other Veil fees.
  // The fee bump locks the fee against the sponsor account.
  const submission = buildSponsoredFeeBumpTransaction({
    innerTransaction: params.innerTx,
    networkPassphrase: params.networkPassphrase,
    sponsor: { secret: params.sponsorSecret },
  })

  // 2. Submit via Soroban RPC
  const sendResult = await rpc.sendTransaction(submission)
  if (sendResult.status === 'ERROR') {
    throw new Error(
      `Private transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`
    )
  }

  // 3. Poll for result
  for (let i = 0; i < 30; i++) {
    const result = await rpc.getTransaction(sendResult.hash)
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Private transaction failed: ${result.status}`)
      }

      // 4. Record fee charged and instructions used, without PII
      try {
        let feeCharged = 'unknown'
        let instructions = 'unknown'

        if (result.resultXdr) {
          feeCharged = result.resultXdr.feeCharged().toString()
        }

        const txAny = params.innerTx as any
        if (txAny.sorobanData) {
          instructions = txAny.sorobanData.resources().instructions().toString()
        }

        Sentry.captureMessage('Private transaction confirmed', {
          level: 'info',
          extra: { feeCharged, instructions },
        })
      } catch (e) {
        // Suppress telemetry errors so they don't break the user flow
      }

      return sendResult.hash
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error('Private transaction timed out - check status manually')
}
