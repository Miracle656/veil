/**
 * Same-origin proxy for the mainnet Soroban RPC endpoint.
 *
 * Upstreams are tried in order (lib/rpcFailover.ts): whatever is configured
 * first, then free public Stellar RPCs. A configured URL may carry an account
 * key, which is why the browser never sees any of them and this route forwards
 * JSON-RPC calls on the client's behalf.
 *
 * Optional server-only settings (no NEXT_PUBLIC_ prefix):
 *   MAINNET_RPC_URL / MAINNET_RPC_URLS  preferred endpoints, tried first
 *   MAINNET_RPC_PUBLIC_FALLBACK=off     never use the public endpoints
 *
 * With nothing set, the public endpoints serve mainnet on their own. That used
 * to be impossible: this route had one upstream, a QuickNode trial with a hard
 * end date, and returned 503 without it — so the trial lapsing would have taken
 * mainnet down for web and mobile together.
 */

import { forwardWithFailover, mainnetUpstreams } from '@/lib/rpcFailover'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'


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
  const upstreams = mainnetUpstreams()

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

  // Tried in order, so a provider that is down, rate limited or out of plan
  // hands over to the next instead of failing every wallet at once.
  const result = await forwardWithFailover(upstreams, JSON.stringify(payload))
  if (!result) {
    return Response.json({ error: 'Mainnet RPC provider is unreachable.' }, { status: 502 })
  }
  if (result.upstreamIndex > 0) {
    // The index, never the URL: a configured upstream carries its API key in the path.
    console.warn(`[rpc/mainnet] answered by fallback upstream #${result.upstreamIndex}`)
  }

  return new Response(result.body, {
    status: result.status,
    headers: {
      'content-type': result.contentType,
      'cache-control': 'no-store',
    },
  })
}

/** Lets the UI check whether mainnet is usable before offering the switch. */
export async function GET(): Promise<Response> {
  // Counts only. The URLs stay server-side: a keyed one carries its key.
  const upstreams = mainnetUpstreams()
  return Response.json({ configured: upstreams.length > 0, upstreams: upstreams.length })
}
