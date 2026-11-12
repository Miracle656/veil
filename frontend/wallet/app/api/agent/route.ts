import { NextResponse, type NextRequest } from 'next/server'
import { createAgentHandler, createRateLimiter } from '@veil/agent-core'
import { providerFromEnv, type LlmProvider } from '@veil/agent-llm'

/**
 * The Veil agent HTTP endpoint.
 *
 * Callers must first authenticate ownership of `walletAddress` via the
 * single-use challenge handshake (`action: 'challenge'` -> `action: 'verify'`),
 * which opens an expiring session bound to the verified wallet address.
 * Subsequent `chat` and `clear_history` calls require the session token and
 * take `walletAddress` exclusively from the verified session, never from the
 * request body.
 *
 * Env (Vercel project settings): OPENROUTER_API_KEY for free models, or
 * ANTHROPIC_API_KEY for Claude. The network follows NEXT_PUBLIC_NETWORK.
 */

export const runtime = 'nodejs'
// A turn is a few model calls plus Horizon lookups; free models can be slow.
export const maxDuration = 60

/** Browsers may call only from the wallet itself. Native apps send no Origin. */
const ALLOWED_ORIGINS = new Set(
  [
    'https://app.useveilapp.xyz',
    ...(process.env.AGENT_ALLOWED_ORIGINS ?? '').split(','),
    process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : '',
  ]
    .map((o) => o.trim())
    .filter(Boolean),
)

// 20 messages a minute per caller, per warm instance. See createRateLimiter.
const allow = createRateLimiter(20, 60_000)
const agentHandler = createAgentHandler()

let provider: LlmProvider | null = null
function llm(): LlmProvider {
  provider ??= providerFromEnv()
  return provider
}

function clientKey(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

/** Health check for the uptime probe. Reports configuration, never secrets. */
export async function GET() {
  const configured = !!(
    process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY
  )
  return NextResponse.json({ ok: configured, model: configured ? llm().label : null })
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  // A browser on another site cannot drive this endpoint with a visitor's
  // session. Requests without an Origin (the mobile app) are allowed and
  // rate-limited instead.
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 })
  }

  if (!allow(clientKey(req))) {
    return NextResponse.json({ error: 'Too many messages. Wait a minute and try again.' }, { status: 429 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 })
  }

  try {
    const dispatched = await agentHandler.dispatch(
      body,
      llm(),
      req.headers.get('authorization'),
    )
    return NextResponse.json(dispatched.body, { status: dispatched.status })
  } catch (err) {
    // Log the detail; return something a person can act on. Provider errors can
    // carry request ids and internals that do not belong in a chat bubble.
    console.error('[agent] turn failed:', err)
    const message = (err as Error)?.message ?? ''
    const friendly = /busy right now/i.test(message)
      ? message
      : 'The assistant could not answer just now. Try again in a moment.'
    return NextResponse.json({ error: friendly }, { status: 502 })
  }
}
