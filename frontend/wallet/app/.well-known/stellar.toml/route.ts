import { NextResponse } from 'next/server'

export async function GET() {
  const tomlContent = `# Stellar Federation Configuration for useveilapp.xyz
FEDERATION_SERVER="https://app.useveilapp.xyz/api/federation"
`

  return new NextResponse(tomlContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  })
}
