/**
 * `POST /api/names/claim` — closed.
 *
 * This route was deployed, open to any origin, and granted a name on the
 * strength of a `paymentTxHash` that was never checked against the ledger:
 * the default verifier in `lib/namesRegistry.ts` returned true for any
 * non-empty string, and the default signature verifier returned true
 * unconditionally. Any caller could take any unreserved name for free, bound
 * to any `passkeyPublicKey` they chose, and — because the registry is
 * in-process — the record would not survive the next cold start anyway.
 *
 * Those defaults now fail closed, so the stub cannot grant anything even if
 * something is wired to it later. This route is shut on top of that, because
 * the registry that matters is `contracts/veil-names` and it is not deployed.
 *
 * See `lib/namesApiGate.ts` for the reasoning and for what lifting the gate
 * requires.
 */

import { NextResponse } from 'next/server'

import { namesCorsHeaders, namesUnavailable } from '@/lib/namesApiGate'

export async function POST() {
  return namesUnavailable()
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: namesCorsHeaders(),
  })
}
