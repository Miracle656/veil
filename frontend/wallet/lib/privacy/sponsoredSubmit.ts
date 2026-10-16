/**
 * Sponsored submission and cost measurement for private transactions (#725).
 *
 * Fee-bumps an SPP transaction from the wallet's own fee payer so the user does
 * not need a funded G-account, then — only behind the diagnostics opt-in —
 * records the two numbers `docs/PRIVACY_COST.md` §2 is built from: the charged
 * fee and the CPU instruction count. Never the hash, the addresses or the
 * amount.
 *
 * Lives beside, not inside, `./client.ts`: that file is the SPP client wrapper
 * (#774) and the SDK submits its own transactions, so this helper has no call
 * site in the shield/send path yet. Wiring it in is follow-on work.
 */
import { Transaction, rpc as SorobanRpc } from '@stellar/stellar-sdk'
import * as Sentry from '@sentry/nextjs'

import { buildSponsoredFeeBumpTransaction } from '../feeBump'
import { getSentryOptIn } from '../sentry'

/** Submit an SPP transaction using the wallet's normal fee-payer account. */
export async function submitPrivateTransaction(params: {
  innerTx: Transaction
  feePayerSecret: string
  rpcUrl: string
  networkPassphrase: string
}): Promise<string> {
  const rpc = new SorobanRpc.Server(params.rpcUrl)
  const submission = buildSponsoredFeeBumpTransaction({
    innerTransaction: params.innerTx,
    networkPassphrase: params.networkPassphrase,
    sponsor: { secret: params.feePayerSecret },
  })

  const sent = await rpc.sendTransaction(submission)
  if (sent.status === 'ERROR') {
    throw new Error(
      `Private transaction rejected: ${sent.errorResult?.toXDR('base64') ?? 'unknown'}`
    )
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await rpc.getTransaction(sent.hash)
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Private transaction failed: ${result.status}`)
      }

      recordPrivateTransactionCost(result, params.innerTx)
      return sent.hash
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  throw new Error('Private transaction timed out. Check its status before retrying.')
}

/** Telemetry is opt-in and contains only the charged fee and CPU instruction count. */
function recordPrivateTransactionCost(
  result: SorobanRpc.Api.GetSuccessfulTransactionResponse,
  transaction: Transaction
): void {
  if (!getSentryOptIn()) return

  try {
    const feeCharged = result.resultXdr?.feeCharged().toString()
    const sorobanData = (transaction as unknown as {
      sorobanData?: { resources(): { instructions(): number | bigint } }
    }).sorobanData
    const instructions = sorobanData?.resources().instructions().toString()
    if (!feeCharged || !instructions) return

    Sentry.captureMessage('Private transaction cost sample', {
      level: 'info',
      extra: { feeCharged, instructions },
    })
  } catch {
    // A diagnostics failure must never change the result of a confirmed payment.
  }
}
