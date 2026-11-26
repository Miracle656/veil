/**
 * The gate on the off-chain names API.
 *
 * `lib/namesRegistry.ts` was the first cut at Veil Names: an in-process
 * registry with a 5 USDC flat price, reached through `POST /api/names/claim`
 * and `GET /api/names/available`. Both routes are deployed. Neither can
 * answer correctly, for two independent reasons:
 *
 * 1. **It cannot hold a claim.** The registry is a set of `Map`s behind a
 *    module singleton. Each serverless instance gets its own, and instances
 *    are recycled, so a name claimed on one request is invisible on the next
 *    and gone after a deploy. There is no database behind it.
 *
 * 2. **It is the wrong price.** The flat 5 USDC predates the respec. A name
 *    is now *rented* by the year in length bands — 3 USDC for 3–5 characters,
 *    5 for 6–10, 2 for 11–20 — for a one-to-five year term, with a 90-day
 *    recovery window. `contracts/veil-names` implements that and is the
 *    source of truth. Quoting 5 USDC flat against a contract that charges by
 *    band means two live prices for the same name.
 *
 * So the routes return 503 until the registry is read from the chain. This is
 * deliberately not an env flag: a flag is a switch somebody eventually flips,
 * and what is behind it hands out names for free (see the fail-closed
 * verifier defaults in `namesRegistry.ts` and why they had to change).
 *
 * To lift the gate: point the routes at the deployed `veil-names` contract —
 * `resolve`, `state` and `quote` answer availability and price, and
 * `register` takes the payment — then delete this module and the in-process
 * registry with it.
 */

import { NextResponse } from 'next/server'

/** CORS headers shared by the names routes. */
export function namesCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

/**
 * The 503 every names route returns while the on-chain registry is not wired.
 *
 * `Retry-After` is omitted on purpose: there is no date to give, and a number
 * invented here would be a promise the deploy schedule has not made.
 */
export function namesUnavailable(): NextResponse {
  return NextResponse.json(
    {
      error:
        'Veil Names is not open yet. Names are registered on-chain and the registry contract is not deployed, so this endpoint cannot reserve or price a name.',
      code: 'NAMES_NOT_AVAILABLE',
    },
    {
      status: 503,
      headers: {
        ...namesCorsHeaders(),
        'Cache-Control': 'no-store',
      },
    },
  )
}
