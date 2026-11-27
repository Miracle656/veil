import { NextResponse, type NextRequest } from 'next/server'
import {
  createAgentAuth,
  createRateLimiter,
  handleChat,
  isAuthFailure,
  parseAuthenticatedChatRequest,
  parseAuthenticatedClearHistoryRequest,
  parseChatRequest,
  parseClaimedAddress,
} from '@veil/agent-core'
import { providerFromEnv, type LlmProvider } from '@veil/agent-llm'
import type { AgentSignedMessage } from '@veil/agent-core'

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
 * Authentication is a wallet-signed challenge (see packages/agent/src/auth.ts).
 * Stellar addresses are public, so a claimed `walletAddress` proves nothing;
 * when a request carries a session token, the address comes from that session
 * — opened after the server verified a passkey signature over a fresh,
 * purpose-bound challenge — and a body address that disagrees is rejected,
 * never honoured.
 *
 * While no mobile build performs the challenge, requests WITHOUT a session are
 * still accepted and served under the claimed (shape-checked) address: mobile
 * posts to this same route and today sends no token, so strict enforcement
 * would lock every installed app out of the agent. Turning enforcement on
 * before that build ships is one env var:
 *
 *   AGENT_REQUIRE_SESSION=true   → requests without a valid session get 401.
 *                                  (default: off — the grace period)
 *
 * Classic (G…) wallets have no passkey and can never verify a challenge, so
 * under enforcement they cannot use the agent at all; during the grace period
 * they keep working through the unauthenticated path.
 *
 * Challenges and sessions are HMAC-signed stateless tokens: any instance of
 * the deployment verifies the others', as long as every instance sets the
 * same AGENT_SESSION_SECRET (see auth.ts). AGENT_RP_ID names the rpId the
 * browser ceremony uses when a verify request arrives without an Origin.
 *
 * Protocol (all POST, JSON):
 *   { action: 'challenge', walletAddress } -> { challenge, expiresAt }
 *   { action: 'verify', challenge, signed } -> { sessionToken, walletAddress, expiresAt }
 *   { message, history, sessionToken } (or Authorization: Bearer) -> agent reply
 *   { action: 'clear_history', sessionToken } -> { history_cleared: true }
 *
 * Env (Vercel project settings): OPENROUTER_API_KEY for free models, or
 * ANTHROPIC_API_KEY for Claude. The network — factory and passphrase both —
 * follows STELLAR_NETWORK, or NEXT_PUBLIC_NETWORK for the wallet's own deploy.
 * AGENT_FACTORY_ADDRESS overrides the built-in passkey-wallet factory.
 */

export const runtime = 'nodejs'
// A turn is a few model calls plus Horizon lookups; free models can be slow.
export const maxDuration = 60

/**
 * Session enforcement is OFF until a mobile build that performs the challenge
 * has shipped (see the header comment). Flip it on with
 * AGENT_REQUIRE_SESSION=true.
 */
const REQUIRE_SESSION = ['1', 'true', 'yes'].includes(
  (process.env.AGENT_REQUIRE_SESSION ?? '').trim().toLowerCase(),
)

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

// Challenges and sessions are stateless signed tokens (see createAgentAuth);
// every warm instance verifies any other's, given the shared
// AGENT_SESSION_SECRET. The local caches below are best-effort single-use /
// revocation bookkeeping, like the rate limiter above.
const auth = createAgentAuth()

let provider: LlmProvider | null = null
function llm(): LlmProvider {
  provider ??= providerFromEnv()
  return provider
}

function clientKey(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

/** The session token, from the Authorization header or the body. Never the address. */
function sessionTokenFrom(req: NextRequest, body: Record<string, unknown>): string {
  const header = req.headers.get('authorization') ?? ''
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return typeof body.sessionToken === 'string' ? body.sessionToken.trim() : ''
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
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>

  // ── Challenge: anyone may ask for one, for any well-formed address. It
  // proves nothing by itself; the proof is the signature over it. ──
  if (b.action === 'challenge') {
    const issued = auth.issueChallenge(typeof b.walletAddress === 'string' ? b.walletAddress : '')
    if (isAuthFailure(issued)) return NextResponse.json({ error: issued.error }, { status: 400 })
    return NextResponse.json(issued)
  }

  // ── Verify: a signature over the issued challenge opens a session. The
  // origin the request arrived with is what the assertion's clientDataJSON
  // origin and rpIdHash must match. A verify without an Origin (a native
  // client, or curl) needs the deployment's AGENT_RP_ID instead. ──
  if (b.action === 'verify') {
    if (typeof b.challenge !== 'string' || !b.challenge) {
      return NextResponse.json({ error: 'challenge is required' }, { status: 400 })
    }
    if (!b.signed || typeof b.signed !== 'object') {
      return NextResponse.json({ error: 'signed challenge is required' }, { status: 400 })
    }
    const rpIdEnv = process.env.AGENT_RP_ID?.trim()
    const expectedOrigin = origin ?? (rpIdEnv ? `https://${rpIdEnv}` : undefined)
    if (!expectedOrigin) {
      return NextResponse.json(
        { error: 'Verification needs a browser Origin or a configured AGENT_RP_ID.' },
        { status: 400 },
      )
    }
    const opened = await auth.verifyChallengeAndOpenSession(b.challenge, b.signed as AgentSignedMessage, {
      expectedOrigin,
    })
    if (isAuthFailure(opened)) return NextResponse.json({ error: opened.error }, { status: 401 })
    return NextResponse.json(opened)
  }

  // ── Chat and clear_history: the address comes from a verified session when
  // there is one, and from the (shape-checked) body claim during the grace
  // period — requests without a session must keep working until a mobile
  // build that performs the challenge has shipped. With a session, a body
  // address that disagrees is rejected, never honoured. ──
  const sessionToken = sessionTokenFrom(req, b)
  const verified = auth.resolveSession(sessionToken)
  if (!verified && REQUIRE_SESSION) {
    return NextResponse.json({ error: 'Agent session required. Complete the wallet challenge first.' }, { status: 401 })
  }

  // ── Clear history: behind the same session, like chat. ──
  if (b.action === 'clear_history') {
    const parsed = verified
      ? parseAuthenticatedClearHistoryRequest(b, verified)
      : parseClaimedAddress(b)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 403 })
    // Serverless keeps no per-wallet history — the client holds the turns —
    // so there is nothing to delete here. The acknowledgement is still gated,
    // so during enforcement a stranger cannot clear or probe someone's chat.
    return NextResponse.json({ history_cleared: true })
  }

  const parsed = verified ? parseAuthenticatedChatRequest(b, verified) : parseChatRequest(b)
  if (!parsed.ok) {
    // Shape problems (no message, bad history) are the client's fault; a
    // mismatched address is someone else's session tried on this body.
    const status = parsed.error === 'walletAddress does not match the session' ? 403 : 400
    return NextResponse.json({ error: parsed.error }, { status })
  }
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
