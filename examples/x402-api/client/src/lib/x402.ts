import { createEd25519Signer } from '@x402/stellar'
import { ExactStellarScheme } from '@x402/stellar/exact/client'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import {
  derivePaymentChallenge,
  type AssertionRecord,
  type PaymentDescriptor,
} from './challenge'
import { X402_NETWORK } from './network'
import type { VeilWallet } from './veil'

/** A paid response together with the passkey assertion that approved it. */
export interface PaidResource<T> {
  data: T
  /** The verified passkey assertion over this exact payment. */
  approval: AssertionRecord
}

/** The user-facing parts of an x402 requirement, bound into the passkey challenge. */
export function describePayment(
  requirement: {
    scheme: string
    network: string
    asset: string
    amount: string
    payTo: string
    maxTimeoutSeconds: number
  },
  resource: string,
): PaymentDescriptor {
  return {
    scheme: requirement.scheme,
    network: requirement.network,
    asset: requirement.asset,
    amount: requirement.amount,
    payTo: requirement.payTo,
    resource,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds,
  }
}

/**
 * Fetches an x402-guarded resource, paying with the Veil fee-payer key when the
 * server answers `402 Payment Required`.
 *
 * Mirrors `packages/agent/src/x402Client.ts` (the agent's machine-to-machine
 * payer) but runs in the browser and signs with the user's Veil wallet key.
 *
 * 1. Plain `fetch`. Anything other than 402 is returned/raised directly.
 * 2. On 402, parse the payment requirements and derive a passkey challenge
 *    from them (amount, recipient, asset, network, resource, timeout). The
 *    `authorise` callback runs the passkey ceremony over that challenge and
 *    must return a verified assertion; nothing is signed before it does.
 * 3. Build + sign a Stellar payment payload with the `exact` scheme, check the
 *    payload pays exactly what was approved, and retry with the
 *    `PAYMENT-SIGNATURE` header.
 * 4. Return the now-200 JSON body with the approval that authorised it.
 */
export async function payForResource<T = unknown>(
  url: string,
  wallet: VeilWallet,
  authorise: (challenge: Uint8Array) => Promise<AssertionRecord>,
): Promise<PaidResource<T>> {
  const first = await fetch(url)
  if (first.status !== 402) {
    throw new Error(
      first.ok
        ? 'Expected 402 Payment Required; nothing to authorise.'
        : `Request failed ${first.status}: ${await first.text()}`,
    )
  }

  const signer = createEd25519Signer(wallet.feePayerSecret, X402_NETWORK)
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

  // Only one requirement is offered and approved, so what the user sees is
  // what gets signed.
  const offered = paymentRequired.accepts.filter(
    (r) => r.scheme === 'exact' && r.network === X402_NETWORK,
  )
  if (offered.length !== 1) {
    throw new Error('Expected exactly one exact-scheme requirement for this network.')
  }
  const challenge = await derivePaymentChallenge(describePayment(offered[0], url))
  const approval = await authorise(challenge)

  const paymentPayload = await http.createPaymentPayload({ ...paymentRequired, accepts: offered })

  const signedFor = await derivePaymentChallenge(describePayment(paymentPayload.accepted, url))
  if (!sameBytes(signedFor, challenge)) {
    throw new Error('Refusing to sign: the payment differs from the one the passkey approved.')
  }
  const paymentHeaders = http.encodePaymentSignatureHeader(paymentPayload)

  const paid = await fetch(url, { headers: { ...paymentHeaders } })
  if (!paid.ok) {
    throw new Error(`Payment accepted but request failed ${paid.status}: ${await paid.text()}`)
  }
  return { data: (await paid.json()) as T, approval }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
