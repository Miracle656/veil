import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import express from 'express'
import cors from 'cors'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type IncomingMessage } from 'http'
import { timingSafeEqual } from 'crypto'
import { Keypair } from '@stellar/stellar-sdk'
import { runAgent, type UserProfile } from './agent.js'

// ── Agent keypair (Ed25519 — for x402 payments only, never signs wallet txs) ──
if (!process.env.AGENT_KEYPAIR_SECRET) {
  console.error('[agent] AGENT_KEYPAIR_SECRET is required')
  process.exit(1)
}
const agentKeypair = Keypair.fromSecret(process.env.AGENT_KEYPAIR_SECRET)
console.log(`[agent] Agent keypair: ${agentKeypair.publicKey()}`)

// ── Shared Anthropic client ──────────────────────────────────────────────────
const anthropicClient = new Anthropic()

// ── Per-wallet conversation history ──────────────────────────────────────────
const conversations = new Map<string, Anthropic.MessageParam[]>()

// ── Access control ────────────────────────────────────────────────────────────
// Allowed browser origins for both CORS and the WebSocket handshake. Set
// ALLOWED_ORIGIN to a comma-separated list (e.g.
// "https://veil.app,https://www.veil.app"). With none set we fall back to
// localhost only — never a wildcard, so an unconfigured deploy is closed to the
// public internet rather than open (the server bills a shared Anthropic key).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

// Shared bearer token for non-browser clients (curl, server-to-server). A
// request with no Origin header bypasses the browser-origin allowlist entirely,
// so instead of trusting origin-less callers we require them to present this
// token. If it is unset, origin-less access is closed rather than open — an
// unconfigured deploy stays private (the server bills a shared Anthropic key).
const AGENT_ACCESS_TOKEN = process.env.AGENT_ACCESS_TOKEN?.trim() ?? ''

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  // timingSafeEqual throws on length mismatch; compare against self to keep the
  // work constant-time regardless, then fold in the length check.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

// Non-browser clients present the token via an `x-agent-token` header or a
// `?token=` query param (browsers cannot set custom WS headers, but curl/scripts
// can use either).
function tokenFromRequest(req: IncomingMessage): string {
  const header = req.headers['x-agent-token']
  if (typeof header === 'string' && header) return header
  try {
    const url = new URL(req.url ?? '', 'http://localhost')
    return url.searchParams.get('token') ?? ''
  } catch {
    return ''
  }
}

function isHandshakeAllowed(info: { origin?: string; req: IncomingMessage }): boolean {
  // Browser requests carry an Origin header — gate them on the allowlist.
  if (info.origin) return ALLOWED_ORIGINS.includes(info.origin)
  // Origin-less requests (curl, scripts, server-to-server) must present the
  // shared token. With no token configured, origin-less access is closed.
  if (!AGENT_ACCESS_TOKEN) return false
  return timingSafeEqualStr(tokenFromRequest(info.req), AGENT_ACCESS_TOKEN)
}

// Cap distinct wallets retained, so a caller cannot exhaust memory by opening
// conversations under many (public) wallet addresses.
const MAX_CONVERSATIONS = 1000
// Per-connection sliding-window message cap, so a single connection cannot bill
// the Anthropic key without bound.
const RATE_WINDOW_MS = 60_000
const RATE_MAX_MESSAGES = 30

function rememberConversation(walletAddress: string, history: Anthropic.MessageParam[]): void {
  conversations.set(walletAddress, history.slice(-20))
  if (conversations.size > MAX_CONVERSATIONS) {
    // Map preserves insertion order → evict the oldest tracked wallet.
    const oldest = conversations.keys().next().value
    if (oldest !== undefined) conversations.delete(oldest)
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const app = express()
app.use(cors({ origin: ALLOWED_ORIGINS }))
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ ok: true, agentAddress: agentKeypair.publicKey() })
})

const httpServer = createServer(app)

// ── WebSocket server ──────────────────────────────────────────────────────────
// Reject the handshake up front for any origin not on the allowlist, so an
// arbitrary page or script cannot open a socket and drive the shared agent.
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: (info, cb) => {
    if (isHandshakeAllowed(info)) return cb(true)
    console.warn(`[agent] rejected WS connection from origin: ${info.origin ?? '(none)'}`)
    cb(false, 403, 'Forbidden')
  },
})

wss.on('connection', (ws: WebSocket) => {
  console.log('[agent] Client connected')

  // Per-connection sliding-window rate limiter.
  const msgTimes: number[] = []

  ws.on('message', async (raw) => {
    const now = Date.now()
    while (msgTimes.length > 0 && now - msgTimes[0] > RATE_WINDOW_MS) msgTimes.shift()
    if (msgTimes.length >= RATE_MAX_MESSAGES) {
      ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded. Please slow down.' }))
      return
    }
    msgTimes.push(now)

    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
      return
    }

    if (msg.type === 'chat') {
      const walletAddress = msg.walletAddress as string
      const feePayerAddress = msg.feePayerAddress as string | undefined
      const userMessage = msg.message as string
      const profile = msg.profile as UserProfile | undefined

      if (!walletAddress || !userMessage) {
        ws.send(JSON.stringify({ type: 'error', message: 'walletAddress and message required' }))
        return
      }

      // Signal "thinking" immediately
      ws.send(JSON.stringify({ type: 'thinking' }))

      try {
        const history = conversations.get(walletAddress) ?? []

        const { response, pendingTxXdr, pendingTxSummary } = await runAgent(
          userMessage,
          walletAddress,
          agentKeypair,
          history,
          feePayerAddress,
          profile,
          anthropicClient,
        )

        // Update conversation history (keep last 20 turns, bounded wallet count)
        history.push({ role: 'user', content: userMessage })
        history.push({ role: 'assistant', content: response })
        rememberConversation(walletAddress, history)

        ws.send(JSON.stringify({
          type: 'response',
          message: response,
          ...(pendingTxXdr ? { pendingTxXdr, pendingTxSummary } : {}),
        }))
      } catch (err) {
        console.error('[agent] runAgent error:', (err as Error).message)
        ws.send(JSON.stringify({ type: 'error', message: (err as Error).message }))
      }
    }

    if (msg.type === 'clear_history') {
      const walletAddress = msg.walletAddress as string
      if (walletAddress) conversations.delete(walletAddress)
      ws.send(JSON.stringify({ type: 'history_cleared' }))
    }
  })

  ws.on('close', () => console.log('[agent] Client disconnected'))
})

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.AGENT_PORT ?? '3001', 10)
httpServer.listen(PORT, () => {
  console.log(`[agent] HTTP  → http://localhost:${PORT}/health`)
  console.log(`[agent] WS   → ws://localhost:${PORT}`)
})
