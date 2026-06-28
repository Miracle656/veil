import { createEd25519Signer } from '@x402/stellar'
import { ExactStellarScheme } from '@x402/stellar/exact/client'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import { X402_NETWORK } from './network'

/**
 * Fetches an x402-guarded resource, paying with the Veil fee-payer key when the
 * server answers `402 Payment Required`.
 *
 * Mirrors `packages/agent/src/x402Client.ts` (the agent's machine-to-machine
 * payer) but runs in the browser and signs with the user's Veil wallet key.
 *
 * 1. Plain `fetch`. Anything other than 402 is returned/raised directly.
 * 2. On 402, parse the payment requirements, build + sign a Stellar payment
 *    payload with the `exact` scheme, and retry with the `PAYMENT-SIGNATURE`
 *    header (`encodePaymentSignatureHeader` produces the correct header name).
 * 3. Return the now-200 JSON body.
 */
export async function payForResource<T = unknown>(
  url: string,
  feePayerSecret: string,
): Promise<T> {
  const first = await fetch(url)
  if (first.status !== 402) {
    if (!first.ok) throw new Error(`Request failed ${first.status}: ${await first.text()}`)
    return (await first.json()) as T
  }

  const signer = createEd25519Signer(feePayerSecret, X402_NETWORK)
  const scheme = new ExactStellarScheme(signer)
  const client = new x402Client().register(X402_NETWORK, scheme)
  const http = new x402HTTPClient(client)

  // x402 v1 carries the requirements in the body, v2 in headers — pass both.
  let body: unknown
  try {
    body = await first.clone().json()
  } catch {
    body = undefined
  }

  const paymentRequired = http.getPaymentRequiredResponse(
    (name: string) => first.headers.get(name),
    body,
  )
  const paymentPayload = await http.createPaymentPayload(paymentRequired)
  const paymentHeaders = http.encodePaymentSignatureHeader(paymentPayload)

  const paid = await fetch(url, { headers: { ...paymentHeaders } })
  if (!paid.ok) {
    throw new Error(`Payment accepted but request failed ${paid.status}: ${await paid.text()}`)
  }
  return (await paid.json()) as T
}
