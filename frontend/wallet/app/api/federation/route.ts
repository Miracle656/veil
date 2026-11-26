/**
 * `GET /api/federation` — the SEP-2 endpoint `stellar.toml` advertises.
 *
 * `public/.well-known/stellar.toml` has published
 *
 *     FEDERATION_SERVER = "https://app.useveilapp.xyz/api/federation"
 *
 * while this route did not exist, so every lookup of a Veil name got Next's
 * HTML 404 where a wallet expected JSON. Veil was naming a federation server
 * it did not run.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0002.md
 *
 * Resolution reads `contracts/veil-names` (see `lib/federationServer.ts`),
 * which is not deployed yet — so today every lookup is a truthful 404 rather
 * than an invented answer. The shape is what matters now: a wallet that
 * handles this endpoint correctly today keeps working the moment the registry
 * is live.
 *
 * ## Which query types are answered
 *
 * - `name` — `alice*useveilapp.xyz` → the address holding it. The one that
 *   matters, and the one `lib/federation.ts` on the client sends.
 * - `id` — reverse lookup. **Not supported**, and that is a property of the
 *   registry, not an omission here: the contract is keyed name → address with
 *   no reverse index, so answering would mean scanning every name. A 404 is
 *   the honest reply, and `lib/reverseResolution.ts` already degrades to null,
 *   which renders the raw address.
 * - `forward` — for handing a payment to an off-network rail. Veil operates
 *   none, so per the spec this is an error rather than a not-found.
 * - `txid` — not supported; Veil has no federation-side transaction records.
 */

import { NextRequest, NextResponse } from 'next/server'

import { lookupFederationName } from '@/lib/federationServer'

/** SEP-2 lookup types, per the spec's `type` parameter. */
const KNOWN_TYPES = ['name', 'id', 'forward', 'txid'] as const

function corsHeaders(): Record<string, string> {
  return {
    // A federation server is public by specification — the whole point is
    // that any wallet, on any origin, can resolve a name without a key.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

/**
 * A 404 body.
 *
 * SEP-2 does not fix the error shape, so this follows the convention of the
 * SDF reference server: a `detail` string. Clients key off the status, which
 * `lib/federation.ts` does — 404 means "address not found" and anything else
 * means "server unreachable", a distinction worth preserving.
 */
function notFound(detail: string): NextResponse {
  return NextResponse.json(
    { detail },
    {
      status: 404,
      headers: {
        ...corsHeaders(),
        // A name's expiry is a ledger fact that can change between requests,
        // and a cached "not found" would outlive a registration. The client
        // keeps its own 60s cache (`DEFAULT_FEDERATION_CACHE_TTL_MS`).
        'Cache-Control': 'no-store',
      },
    },
  )
}

function badRequest(detail: string): NextResponse {
  return NextResponse.json({ detail }, { status: 400, headers: corsHeaders() })
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')
  const type = searchParams.get('type')

  if (!q) return badRequest('Query parameter "q" is required.')
  if (!type) return badRequest('Query parameter "type" is required.')
  if (!(KNOWN_TYPES as readonly string[]).includes(type)) {
    return badRequest(`Unknown lookup type "${type}". Expected one of: ${KNOWN_TYPES.join(', ')}.`)
  }

  if (type === 'forward') {
    // Not a 404: the spec reserves `forward` for handing a payment to an
    // off-network rail, and Veil runs none. Saying "not found" would imply
    // the right destination might exist, which it cannot.
    return badRequest('This federation server does not support forward requests.')
  }

  if (type === 'txid') {
    return notFound('This federation server does not record transaction ids.')
  }

  if (type === 'id') {
    // See the module header: the registry has no reverse index.
    return notFound('This federation server does not support reverse lookups.')
  }

  const record = await lookupFederationName(q)
  if (!record) {
    return notFound(`No Veil name matches ${q}.`)
  }

  return NextResponse.json(record, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Cache-Control': 'no-store',
    },
  })
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}
