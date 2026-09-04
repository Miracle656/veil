/**
 * Same-origin proxy for the mainnet Soroban RPC endpoint.
 *
 * Mainnet Soroban RPC has no free public provider, so the URL we use carries an
 * account key. The browser needs to reach *some* RPC, but shipping that URL to
 * the browser via `NEXT_PUBLIC_MAINNET_RPC_URL` would publish the key to every
 * visitor of the live site — and the current endpoint is a metered trial, so a
 * leaked key is a real, immediate cost. This route keeps the URL in a
 * server-only variable and forwards JSON-RPC calls on the client's behalf.
 *
 * Set `MAINNET_RPC_URL` (note: no NEXT_PUBLIC_ prefix) in the deployment
 * environment. Without it this route reports 503 and the UI keeps mainnet
 * disabled rather than failing halfway through a transaction.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function upstreamUrl(): string {
  return (
    process.env.MAINNET_RPC_URL?.trim()
    || process.env.SOROBAN_MAINNET_RPC_URL?.trim()
    || ''
  )
}

/**
 * Only the JSON-RPC methods the wallet actually calls are forwarded. The
 * upstream endpoint is metered and this route is public by construction, so an
 * open relay would let anyone drain the quota. Unknown methods are rejected
 * rather than passed through.
 */
const ALLOWED_METHODS = new Set([
  'getHealth',
  'getNetwork',
  'getVersionInfo',
  'getLatestLedger',
  'getFeeStats',
  'getLedgerEntries',
  'getEvents',
  'getTransaction',
  'getTransactions',
  'simulateTransaction',
  'sendTransaction',
])

type JsonRpcCall = { method?: unknown; id?: unknown }

function disallowedMethod(payload: unknown): string | null {
  const calls: JsonRpcCall[] = Array.isArray(payload) ? payload : [payload as JsonRpcCall]
  for (const call of calls) {
    const method = typeof call?.method === 'string' ? call.method : ''
    if (!ALLOWED_METHODS.has(method)) return method || '(missing)'
  }
  return null
}

export async function POST(request: Request): Promise<Response> {
  const upstream = upstreamUrl()
  if (!upstream) {
    return Response.json(
      { error: 'Mainnet RPC is not configured on this deployment. Set MAINNET_RPC_URL.' },
      { status: 503 },
    )
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return Response.json({ error: 'Request body must be JSON-RPC.' }, { status: 400 })
  }

  const rejected = disallowedMethod(payload)
  if (rejected) {
    return Response.json({ error: `JSON-RPC method not allowed: ${rejected}` }, { status: 403 })
  }

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    })
  } catch {
    // Never echo the upstream URL — it carries the key.
    return Response.json({ error: 'Mainnet RPC provider is unreachable.' }, { status: 502 })
  }

  const body = await upstreamResponse.text()
  return new Response(body, {
    status: upstreamResponse.status,
    headers: {
      'content-type': upstreamResponse.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  })
}

/** Lets the UI check whether mainnet is usable before offering the switch. */
export async function GET(): Promise<Response> {
  return Response.json({ configured: upstreamUrl().length > 0 })
}
