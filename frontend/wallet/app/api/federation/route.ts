import { NextRequest, NextResponse } from 'next/server'
import {
  resolveFederationName,
  resolveFederationId,
  NameNotFoundError,
  UnreadableHolderError,
  FEDERATION_SERVER_CACHE_TTL_SEC,
} from '@/lib/namesResolver'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const q = searchParams.get('q')?.trim()
  const type = searchParams.get('type')?.trim().toLowerCase()

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': `public, max-age=${FEDERATION_SERVER_CACHE_TTL_SEC}, s-maxage=${FEDERATION_SERVER_CACHE_TTL_SEC}`,
  }

  if (!q || !type) {
    return NextResponse.json(
      { detail: 'Missing required query parameters: q and type are required' },
      { status: 400, headers: corsHeaders },
    )
  }

  try {
    if (type === 'name') {
      const result = await resolveFederationName(q)
      return NextResponse.json(result, { status: 200, headers: corsHeaders })
    }

    if (type === 'id') {
      const result = await resolveFederationId(q)
      return NextResponse.json(result, { status: 200, headers: corsHeaders })
    }

    return NextResponse.json(
      { detail: `Unsupported federation query type "${type}". Supported types are "name" and "id"` },
      { status: 400, headers: corsHeaders },
    )
  } catch (err: unknown) {
    if (err instanceof NameNotFoundError) {
      return NextResponse.json({ detail: 'address not found' }, { status: 404, headers: corsHeaders })
    }

    if (err instanceof UnreadableHolderError) {
      // Unreadable on-chain holder is an explicit error, never a fallback to stale data
      return NextResponse.json(
        { detail: err.message },
        { status: 502, headers: corsHeaders },
      )
    }

    const message = err instanceof Error ? err.message : 'Federation query failed'
    if (message.includes('not found')) {
      return NextResponse.json({ detail: 'address not found' }, { status: 404, headers: corsHeaders })
    }

    return NextResponse.json({ detail: message }, { status: 500, headers: corsHeaders })
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}
