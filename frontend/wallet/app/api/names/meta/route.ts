/**
 * `GET /api/names/meta` — does a Veil name accept stealth payments?
 *
 * Reads `meta_address(name)` off `contracts/veil-names`. It exists because a
 * browser cannot call the contract directly without an RPC round trip and a
 * simulation envelope, and because the refusal has to be identical wherever
 * it is asked.
 *
 * ## The 404 is the feature
 *
 * A name with no published record answers **404 `NO_META_ADDRESS`**, not an
 * empty 200. A sender that asked for a meta-address and got one back would
 * derive a one-time address; there is no record to derive from here, so the
 * only honest answer is that the private path does not exist. Falling back to
 * the name's public address would send in public while the caller believes it
 * is sending privately.
 *
 * `q` is a federated address (`ada*useveilapp.xyz`) rather than a bare name so
 * this endpoint and `/api/federation` agree on what a name is, including the
 * domain check. Being asked about another domain is a 400 here, not a 404:
 * the query is not a Veil name at all.
 */

import { NextRequest, NextResponse } from 'next/server'

import { lookupNameMetaAddress, parseFederationName } from '@/lib/federationServer'

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function errorJson(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      ...corsHeaders(),
      // A meta-address can be published or removed between requests, and a
      // cached 404 would keep refusing a name that has since opted in.
      'Cache-Control': 'no-store',
    },
  })
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')

  if (!q) {
    return errorJson(400, {
      error: 'MISSING_QUERY',
      detail: 'Query parameter "q" is required, e.g. q=ada*useveilapp.xyz.',
    })
  }

  const parsed = parseFederationName(q)
  if (!parsed) {
    return errorJson(400, {
      error: 'NOT_A_VEIL_NAME',
      detail: `${q} is not a Veil name. Meta-addresses are only served for names under useveilapp.xyz.`,
    })
  }

  // Stealth name lookups are a testnet-only, explicitly opted-in preview.
  // The mainnet registry has not been upgraded with meta_address, so querying
  // it must never be presented as evidence that a holder has not opted in.
  const privacyFlagOn =
    process.env.NEXT_PUBLIC_PRIVACY_FEATURE_FLAG === '1' ||
    process.env.NEXT_PUBLIC_PRIVACY_FEATURE_FLAG === 'true'
  if (process.env.VEIL_FEDERATION_NETWORK !== 'testnet' || !privacyFlagOn) {
    return errorJson(503, {
      error: 'PRIVACY_DISABLED',
      detail: 'Stealth name lookup is available only on testnet when the privacy preview is enabled.',
    })
  }

  let record
  try {
    record = await lookupNameMetaAddress(q)
  } catch {
    // Missing contract methods, RPC outages and simulation failures are all
    // unavailable lookups, not proof that a name has no published record.
    return errorJson(503, {
      error: 'META_ADDRESS_LOOKUP_UNAVAILABLE',
      detail: 'The names registry could not answer the stealth meta-address lookup. Please try again later.',
    })
  }
  if (!record) {
    return errorJson(404, {
      error: 'NO_META_ADDRESS',
      detail:
        `${parsed.name}*${parsed.domain} has not published a stealth meta-address, so there is ` +
        'no one-time address to derive. Paying this name is a public payment.',
    })
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
