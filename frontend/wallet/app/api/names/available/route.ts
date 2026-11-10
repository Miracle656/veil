/**
 * `GET /api/names/available` — closed.
 *
 * It used to answer from the in-process registry in `lib/namesRegistry.ts`,
 * which is always empty in production, so every name came back
 * `available: true` with `Cache-Control: public, max-age=10` on it. A client
 * could cache a yes for a name that is registered on-chain. See
 * `lib/namesApiGate.ts` for why this is shut rather than flagged.
 */

import { NextResponse } from 'next/server'

import { namesCorsHeaders, namesUnavailable } from '@/lib/namesApiGate'

export async function GET() {
  return namesUnavailable()
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: namesCorsHeaders(),
  })
}
