import { NextRequest, NextResponse } from 'next/server'
import { globalNamesRegistry } from '@/lib/namesRegistry'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const name = searchParams.get('name')

  if (!name) {
    return NextResponse.json(
      { error: 'Query parameter "name" is required.' },
      { status: 400, headers: corsHeaders() },
    )
  }

  const result = globalNamesRegistry.checkAvailability(name)

  return NextResponse.json(
    {
      name,
      ...result,
    },
    {
      status: 200,
      headers: {
        ...corsHeaders(),
        'Cache-Control': 'public, max-age=10, s-maxage=10',
      },
    },
  )
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(),
  })
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
