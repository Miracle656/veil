/**
 * Mainnet RPC upstreams, and forwarding with failover between them.
 *
 * The proxy used to have exactly one upstream, a QuickNode trial with a hard
 * end date. When it lapsed, every mainnet balance, send, swap and deposit —
 * web and mobile, since the APK talks to this proxy too — would have failed at
 * once, with nothing to fall back to.
 *
 * Public Stellar RPCs exist that need no key. Each was checked against the
 * calls Veil makes (ledger entries, simulate, events, fee stats, transactions)
 * on 2026-09-14. They are rate limited per client IP, and this proxy is one
 * client for every user, so one of them alone can be exhausted by the app's own
 * traffic. Several, tried in order, cannot all be at once.
 *
 * Lightsail and sorobanrpc.com appear to share an operator, so they are not
 * placed back to back: an outage on one side still leaves an independent
 * provider next in line.
 */

export const PUBLIC_MAINNET_RPCS: readonly string[] = [
  'https://rpc.lightsail.network',
  'https://soroban-rpc.mainnet.stellar.gateway.fm',
  'https://mainnet.sorobanrpc.com',
  'https://rpc.ankr.com/stellar_soroban',
]

type Env = Record<string, string | undefined>

/**
 * Upstreams in the order to try them: anything configured first (a paid or
 * keyed endpoint), then the public ones. `MAINNET_RPC_URLS` takes a
 * comma-separated list; the single-URL variables stay supported.
 */
export function mainnetUpstreams(env: Env = process.env): string[] {
  const configured = [
    env.MAINNET_RPC_URL,
    env.SOROBAN_MAINNET_RPC_URL,
    ...(env.MAINNET_RPC_URLS ?? '').split(','),
  ]
    .map((u) => u?.trim() ?? '')
    .filter(Boolean)
  const usePublic = env.MAINNET_RPC_PUBLIC_FALLBACK?.trim() !== 'off'
  return [...new Set([...configured, ...(usePublic ? PUBLIC_MAINNET_RPCS : [])])]
}

/**
 * A reply that says "this provider cannot serve you right now", as opposed to
 * an answer about the request. A JSON-RPC error about the transaction itself
 * (bad XDR, a failed simulation) is an answer: another provider would say the
 * same, so it is returned, not retried.
 */
export function isProviderRefusal(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 429 || status >= 500) return true
  if (status !== 200) return false
  // Some providers refuse inside a 200: an expired plan or a spent quota comes
  // back as a top-level JSON-RPC error rather than an HTTP status.
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    const message = typeof parsed?.error?.message === 'string' ? parsed.error.message : ''
    return /rate.?limit|too many|quota|api.?key|unauthori[sz]ed|forbidden|expired|suspended|disabled|credits/i.test(message)
  } catch {
    return false
  }
}

export type ForwardResult = {
  status: number
  body: string
  contentType: string
  /** Which upstream answered, by position, for logs. Never the URL: keyed URLs carry the key. */
  upstreamIndex: number
}

/**
 * POST `body` to each upstream in turn until one answers.
 *
 * Retrying `sendTransaction` on another provider is safe: a signed transaction
 * has one hash, and the network accepts it at most once.
 */
export async function forwardWithFailover(
  upstreams: readonly string[],
  body: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<ForwardResult | null> {
  let lastRefusal: ForwardResult | null = null

  for (let i = 0; i < upstreams.length; i++) {
    let response: Response
    try {
      response = await fetchImpl(upstreams[i], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      continue // unreachable or timed out
    }

    let text: string
    try {
      text = await response.text()
    } catch {
      continue // the connection dropped mid-body
    }
    const result: ForwardResult = {
      status: response.status,
      body: text,
      contentType: response.headers.get('content-type') ?? 'application/json',
      upstreamIndex: i,
    }
    if (!isProviderRefusal(response.status, text)) return result
    lastRefusal = result
  }

  // Every provider refused: pass on the last refusal (a 429 says more than a
  // generic 502), or null when none could be reached at all.
  return lastRefusal
}
