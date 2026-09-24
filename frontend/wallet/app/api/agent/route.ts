import { NextResponse, type NextRequest } from 'next/server'
import { createRateLimiter, handleChat, parseChatRequest } from '@veil/agent-core'
import { providerFromEnv, type LlmProvider } from '@veil/agent-llm'

/**
 * The Veil agent, as one serverless function.
 *
 * It used to run as a WebSocket server on its own Render service, which needed
 * an always-on host and a funded key for x402 data fees. Now each chat message
 * is one POST: the client sends the recent conversation, the function runs the
 * model's tool loop (balances, history and prices straight from Horizon) and
 * returns the reply, plus any transaction for the user to approve with their
 * passkey. The function never holds keys and never signs anything.
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
  const configured = !!(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY)
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

  const parsed = parseChatRequest(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    const result = await handleChat(parsed.value, llm())
    return NextResponse.json(result)
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
