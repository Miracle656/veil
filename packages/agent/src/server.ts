import 'dotenv/config'
import express, { type Express } from 'express'
import cors from 'cors'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'http'
import { timingSafeEqual } from 'crypto'
import { runAgent, type UserProfile } from './agent.js'
import {
  createAgentAuthManager,
  type AgentAuthManager,
  type AgentAuthOptions,
  type AgentSession,
  type SessionVerifyResult,
} from './auth.js'
import { providerFromEnv, type ChatTurn, type LlmProvider } from './llm.js'
import { NETWORK } from './network.js'

/**
 * Architectural note on `server.ts` vs `handler.ts` (Issue #1314):
 *
 * The wallet frontend on Vercel uses the stateless/serverless HTTP entry point
 * (`handler.ts` via `/api/agent`), while self-hosted deployments and SDK users
 * can run this persistent Express + WebSocket server (`@veil/agent/server`).
 * Rather than removing `server.ts`, it is secured behind the exact same
 * `AgentAuthManager` challenge/session check:
 *   1. Client requests a single-use challenge (`type: 'auth_challenge'` over WS
 *      or `POST /auth/challenge` over HTTP).
 *   2. Client signs the challenge with the key controlling `walletAddress` and
 *      submits `type: 'auth_verify'` (or `POST /auth/verify`) to obtain an
 *      expiring `AgentSession`.
 *   3. `chat` and `clear_history` require a valid, non-expired session and take
 *      `walletAddress` exclusively from `session.walletAddress`, never from the
 *      incoming message body.
 */

// ── Resource limit constants ──────────────────────────────────────────────────
// Max incoming WebSocket message size (64 KiB). Rejected at frame level so memory
// is not allocated for oversized messages.
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024
export const MAX_PAYLOAD_BYTES = parseInt(process.env.AGENT_MAX_PAYLOAD_BYTES ?? '', 10) || DEFAULT_MAX_PAYLOAD_BYTES

// Cap concurrent connections globally and per remote address to prevent exhaustion.
export const DEFAULT_MAX_TOTAL_CONNECTIONS = 100
export const MAX_TOTAL_CONNECTIONS = parseInt(process.env.AGENT_MAX_TOTAL_CONNECTIONS ?? '', 10) || DEFAULT_MAX_TOTAL_CONNECTIONS

export const DEFAULT_MAX_CONNECTIONS_PER_IP = 10
export const MAX_CONNECTIONS_PER_IP = parseInt(process.env.AGENT_MAX_CONNECTIONS_PER_IP ?? '', 10) || DEFAULT_MAX_CONNECTIONS_PER_IP

// Cap distinct wallets retained, so a caller cannot exhaust memory by opening
// conversations under many (public) wallet addresses.
export const MAX_CONVERSATIONS = 1000

// Rate limit: sliding-window message cap keyed by IP address so it survives reconnection.
export const RATE_WINDOW_MS = 60_000
export const RATE_MAX_MESSAGES = 30
export const MAX_RATE_LIMIT_KEYS = 10_000

const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/

// ── Helpers ───────────────────────────────────────────────────────────────────
export function timingSafeEqualStr(a: string, b: string): boolean {
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
export function tokenFromRequest(req: IncomingMessage): string {
  const header = req.headers['x-agent-token']
  if (typeof header === 'string' && header) return header
  try {
    const url = new URL(req.url ?? '', 'http://localhost')
    return url.searchParams.get('token') ?? ''
  } catch {
    return ''
  }
}

export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded) {
    return forwarded.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

export function isHandshakeAllowed(
  info: { origin?: string; req: IncomingMessage },
  allowedOrigins: string[],
  accessToken: string,
): boolean {
  // Browser requests carry an Origin header — gate them on the allowlist.
  if (info.origin) return allowedOrigins.includes(info.origin)
  // Origin-less requests (curl, scripts, server-to-server) must present the
  // shared token. With no token configured, origin-less access is closed.
  if (!accessToken) return false
  return timingSafeEqualStr(tokenFromRequest(info.req), accessToken)
}

export interface ServerOptions {
  port?: number
  allowedOrigins?: string[]
  accessToken?: string
  maxPayload?: number
  maxTotalConnections?: number
  maxConnectionsPerIp?: number
  rateWindowMs?: number
  rateMaxMessages?: number
  autoListen?: boolean
  llmProvider?: LlmProvider
  authManager?: AgentAuthManager
  authOptions?: AgentAuthOptions
}

export interface AgentServerInstance {
  app: Express
  httpServer: HttpServer
  wss: WebSocketServer
  connectionsByIp: Map<string, Set<WebSocket>>
  rateLimits: Map<string, number[]>
  conversations: Map<string, ChatTurn[]>
  auth: AgentAuthManager
  close: () => Promise<void>
}

export function createAgentServer(options: ServerOptions = {}): AgentServerInstance {
  const allowedOrigins = options.allowedOrigins ?? (process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  const accessToken = options.accessToken ?? (process.env.AGENT_ACCESS_TOKEN?.trim() ?? '')
  const maxPayload = options.maxPayload ?? MAX_PAYLOAD_BYTES
  const maxTotalConnections = options.maxTotalConnections ?? MAX_TOTAL_CONNECTIONS
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP
  const rateWindowMs = options.rateWindowMs ?? RATE_WINDOW_MS
  const rateMaxMessages = options.rateMaxMessages ?? RATE_MAX_MESSAGES
  const llm = options.llmProvider ?? providerFromEnv()
  const port = options.port ?? parseInt(process.env.AGENT_PORT ?? '3001', 10)
  const auth = options.authManager ?? createAgentAuthManager(options.authOptions)

  // Per-wallet conversation history (keyed exclusively by verified session.walletAddress)
  const conversations = new Map<string, ChatTurn[]>()

  function rememberConversation(walletAddress: string, history: ChatTurn[]): void {
    conversations.set(walletAddress, history.slice(-20))
    if (conversations.size > MAX_CONVERSATIONS) {
      // Map preserves insertion order → evict the oldest tracked wallet.
      const oldest = conversations.keys().next().value
      if (oldest !== undefined) conversations.delete(oldest)
    }
  }

  // Active connection and rate limit tracking
  const connectionsByIp = new Map<string, Set<WebSocket>>()
  const rateLimits = new Map<string, number[]>()

  function registerConnection(ip: string, ws: WebSocket): void {
    let set = connectionsByIp.get(ip)
    if (!set) {
      set = new Set()
      connectionsByIp.set(ip, set)
    }
    set.add(ws)
  }

  function unregisterConnection(ip: string, ws: WebSocket): void {
    const set = connectionsByIp.get(ip)
    if (set) {
      set.delete(ws)
      if (set.size === 0) {
        connectionsByIp.delete(ip)
      }
    }
  }

  function checkAndRecordRateLimit(ip: string, now = Date.now()): boolean {
    let times = rateLimits.get(ip)
    if (!times) {
      times = []
      rateLimits.set(ip, times)
      if (rateLimits.size > MAX_RATE_LIMIT_KEYS) {
        const oldestKey = rateLimits.keys().next().value
        if (oldestKey !== undefined) rateLimits.delete(oldestKey)
      }
    }
    while (times.length > 0 && now - times[0] > rateWindowMs) {
      times.shift()
    }
    if (times.length >= rateMaxMessages) {
      return false
    }
    times.push(now)
    return true
  }

  // ── HTTP server ─────────────────────────────────────────────────────────────
  const app = express()
  app.use(cors({ origin: allowedOrigins }))
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ ok: true, network: NETWORK, model: llm.label })
  })

  app.post('/auth/challenge', (req, res) => {
    const result = auth.issueChallenge(req.body?.walletAddress)
    if (!result.ok) {
      res.status(400).json({ error: result.error })
      return
    }
    res.json({
      challenge: result.challenge,
      walletAddress: result.walletAddress,
      expiresAt: result.expiresAt,
    })
  })

  app.post('/auth/verify', async (req, res) => {
    const result = await auth.verifyChallenge(req.body)
    if (!result.ok) {
      res.status(401).json({ error: result.error })
      return
    }
    res.json({
      sessionToken: result.session.sessionToken,
      walletAddress: result.session.walletAddress,
      expiresAt: result.session.expiresAt,
    })
  })

  const httpServer = createServer(app)

  // ── WebSocket server ────────────────────────────────────────────────────────
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload,
    verifyClient: (info, cb) => {
      if (!isHandshakeAllowed(info, allowedOrigins, accessToken)) {
        console.warn(`[agent] rejected WS connection from origin: ${info.origin ?? '(none)'}`)
        cb(false, 403, 'Forbidden')
        return
      }

      // Check global concurrent connection cap
      if (wss.clients.size >= maxTotalConnections) {
        console.warn(`[agent] rejected WS connection: global cap (${maxTotalConnections}) reached`)
        cb(false, 503, 'Service Unavailable')
        return
      }

      // Check per-IP concurrent connection cap
      const ip = getClientIp(info.req)
      const currentIpCount = connectionsByIp.get(ip)?.size ?? 0
      if (currentIpCount >= maxConnectionsPerIp) {
        console.warn(`[agent] rejected WS connection from ${ip}: per-IP cap (${maxConnectionsPerIp}) reached`)
        cb(false, 429, 'Too Many Requests')
        return
      }

      cb(true)
    },
  })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    console.log('[agent] Client connected')
    const clientIp = getClientIp(req)
    registerConnection(clientIp, ws)

    let socketSession: AgentSession | null = null

    function resolveSession(msg: Record<string, unknown>): SessionVerifyResult {
      if (typeof msg.sessionToken === 'string' && msg.sessionToken.trim()) {
        return auth.verifySession(msg.sessionToken)
      }
      if (socketSession) {
        return auth.verifySession(socketSession.sessionToken)
      }
      return { ok: false, error: 'Authentication required' }
    }

    ws.on('message', async (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
        return
      }

      if (msg.type === 'auth_challenge') {
        const res = auth.issueChallenge(msg.walletAddress)
        if (!res.ok) {
          ws.send(JSON.stringify({ type: 'error', message: res.error }))
          return
        }
        ws.send(
          JSON.stringify({
            type: 'auth_challenge',
            challenge: res.challenge,
            walletAddress: res.walletAddress,
            expiresAt: res.expiresAt,
          }),
        )
        return
      }

      if (msg.type === 'auth_verify') {
        const res = await auth.verifyChallenge(msg)
        if (!res.ok) {
          ws.send(JSON.stringify({ type: 'error', message: res.error }))
          return
        }
        socketSession = res.session
        ws.send(
          JSON.stringify({
            type: 'authenticated',
            sessionToken: res.session.sessionToken,
            walletAddress: res.session.walletAddress,
            expiresAt: res.session.expiresAt,
          }),
        )
        return
      }

      if (!checkAndRecordRateLimit(clientIp)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded. Please slow down.' }))
        return
      }

      if (msg.type === 'chat') {
        const verified = resolveSession(msg)
        if (!verified.ok) {
          ws.send(JSON.stringify({ type: 'error', message: verified.error }))
          return
        }

        // Security invariant: take walletAddress strictly from the verified session,
        // never from msg.walletAddress in the request payload.
        const walletAddress = verified.session.walletAddress
        const userMessage = typeof msg.message === 'string' ? msg.message.trim() : ''
        const rawFeePayer = typeof msg.feePayerAddress === 'string' ? msg.feePayerAddress.trim() : undefined
        const feePayerAddress =
          rawFeePayer && STELLAR_ACCOUNT.test(rawFeePayer)
            ? rawFeePayer
            : verified.session.feePayerAddress
        const profile = msg.profile as UserProfile | undefined

        if (!userMessage) {
          ws.send(JSON.stringify({ type: 'error', message: 'message required' }))
          return
        }

        // Signal "thinking" immediately
        ws.send(JSON.stringify({ type: 'thinking' }))

        try {
          const history = [...(conversations.get(walletAddress) ?? [])]

          const { response, pendingTxXdr, pendingTxSummary } = await runAgent(
            userMessage,
            walletAddress,
            [...history],
            feePayerAddress,
            profile,
            llm,
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
          // Do not leak internal error message details to clients
          ws.send(JSON.stringify({ type: 'error', message: 'An internal error occurred. Please try again later.' }))
        }
      }

      if (msg.type === 'clear_history') {
        const verified = resolveSession(msg)
        if (!verified.ok) {
          ws.send(JSON.stringify({ type: 'error', message: verified.error }))
          return
        }

        // Security invariant: only clear the authenticated session's own history;
        // never read msg.walletAddress from the payload.
        const walletAddress = verified.session.walletAddress
        conversations.delete(walletAddress)
        ws.send(JSON.stringify({ type: 'history_cleared' }))
      }
    })

    const cleanup = () => {
      socketSession = null
      unregisterConnection(clientIp, ws)
      console.log('[agent] Client disconnected')
    }

    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })

  const close = async (): Promise<void> => {
    return new Promise<void>((resolve) => {
      wss.close(() => {
        httpServer.close(() => {
          resolve()
        })
      })
    })
  }

  const shouldListen = options.autoListen ?? (process.env.NODE_ENV !== 'test')
  if (shouldListen) {
    httpServer.listen(port, () => {
      console.log(`[agent] ${NETWORK} · model ${llm.label}`)
      console.log(`[agent] HTTP  → http://localhost:${port}/health`)
      console.log(`[agent] WS   → ws://localhost:${port}`)
    })
  }

  return {
    app,
    httpServer,
    wss,
    connectionsByIp,
    rateLimits,
    conversations,
    auth,
    close,
  }
}

// ── Default instance for export & direct execution ────────────────────────────
export const defaultServer = createAgentServer()
export const { app, httpServer, wss, connectionsByIp, rateLimits, conversations, auth } = defaultServer
