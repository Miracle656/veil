import { NextRequest, NextResponse } from 'next/server'
import { globalNamesRegistry } from '@/lib/namesRegistry'
import { getMasqueradeFigureForOrder } from '@/lib/masquerade'

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
  const nextClaimOrder = globalNamesRegistry.getAllClaims().length + 1
  const figureStatus = getMasqueradeFigureForOrder(nextClaimOrder)

  return NextResponse.json(
    {
      name,
      ...result,
      price: '5 USDC',
      priceUsdc: 5,
      nextClaimOrder,
      hasFigure: figureStatus.hasFigure,
      figure: figureStatus.figure,
      figureWarning: figureStatus.warning,
      figureNote: figureStatus.note,
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
