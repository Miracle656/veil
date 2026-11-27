import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

function normalizeDomain(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  let url: URL
  try {
    if (raw.includes('://')) {
      url = new URL(raw)
    } else {
      url = new URL(`https://${raw}`)
    }
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  // Only the well-known stellar.toml path may be fetched.
  const target = `${url.origin}/.well-known/stellar.toml`
  return target
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const domain = searchParams.get('domain') || searchParams.get('issuer') || searchParams.get('host') || ''
  const target = normalizeDomain(domain)
  if (!target) {
    return NextResponse.json({ error: 'A valid domain or issuer is required.' }, { status: 400 })
  }
  try {
    const response = await fetch(target, { cache: 'no-store' })
    if (!response.ok) {
      return NextResponse.json({ error: `stellar.toml fetch failed: ${response.status}` }, { status: response.status })
    }
    const text = await response.text()
    return new NextResponse(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'fetch failed' }, { status: 502 })
  }
}
