import { runAgent, type AgentResult, type UserProfile } from './agent.js'
import {
  createAgentAuthManager,
  STELLAR_ADDRESS,
  type AgentAuthManager,
  type AgentAuthOptions,
  type AgentSession,
} from './auth.js'
import type { ChatTurn, LlmProvider } from './llm.js'

export {
  buildChallengePayload,
  createAgentAuthManager,
  DEFAULT_CHALLENGE_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  deriveContractWalletAddress,
  MAX_ACTIVE_SESSIONS,
  MAX_PENDING_CHALLENGES,
  STELLAR_ADDRESS,
  type AgentAuthManager,
  type AgentAuthOptions,
  type AgentSession,
  type ChallengeIssueResult,
  type ChallengeRecord,
  type SessionVerifyResult,
  type VerifyChallengeInput,
  type WebAuthnChallengeProof,
} from './auth.js'

/**
 * Authenticated chat and history handlers over plain HTTP.
 *
 * Callers must first prove control of `walletAddress` via the challenge/verify
 * handshake (`issueChallenge` -> `verifyChallenge`), which returns a short-lived
 * `AgentSession` bound to that verified address. After authentication, handlers
 * take `walletAddress` exclusively from `session.walletAddress` and never read
 * `walletAddress` from the request body.
 */

/** Turns of earlier conversation the model sees. Older turns are dropped. */
export const MAX_HISTORY_TURNS = 20
export const MAX_MESSAGE_CHARS = 2_000
const MAX_TURN_CHARS = 4_000
const MAX_PROFILE_FIELD_CHARS = 80
const MAX_STORED_CONVERSATIONS = 1_000

const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/

export interface ChatRequest {
  message: string
  walletAddress: string
  feePayerAddress?: string
  profile?: UserProfile
  history: ChatTurn[]
}

export type ParseResult = { ok: true; value: ChatRequest } | { ok: false; error: string }

function shortString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_PROFILE_FIELD_CHARS) : undefined
}

/**
 * Validates and bounds a chat request body for an already-authenticated session.
 *
 * Security invariant: `walletAddress` is taken exclusively from `session.walletAddress`
 * and is never read from `body`. Even if a client sends another wallet's address in
 * `body.walletAddress`, it is ignored so a caller can never read or act on someone
 * else's wallet.
 */
export function parseChatRequest(body: unknown, session: AgentSession | null | undefined): ParseResult {
  if (!session || typeof session !== 'object' || !STELLAR_ADDRESS.test(session.walletAddress)) {
    return { ok: false, error: 'Authentication required' }
  }
  if (!body || typeof body !== 'object') return { ok: false, error: 'Expected a JSON body' }
  const b = body as Record<string, unknown>

  const message = typeof b.message === 'string' ? b.message.trim() : ''
  if (!message) return { ok: false, error: 'message is required' }
  if (message.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `message is longer than ${MAX_MESSAGE_CHARS} characters` }
  }

  // Always take walletAddress from the verified session, never from the request body.
  const walletAddress = session.walletAddress

  let feePayerAddress: string | undefined = session.feePayerAddress
  if (b.feePayerAddress !== undefined && b.feePayerAddress !== null && b.feePayerAddress !== '') {
    if (typeof b.feePayerAddress !== 'string' || !STELLAR_ACCOUNT.test(b.feePayerAddress.trim())) {
      return { ok: false, error: 'feePayerAddress is not a Stellar account' }
    }
    const candidateFeePayer = b.feePayerAddress.trim()
    if (session.feePayerAddress && candidateFeePayer !== session.feePayerAddress) {
      return { ok: false, error: 'feePayerAddress does not match authenticated session' }
    }
    feePayerAddress = candidateFeePayer
  }

  const rawProfile = b.profile && typeof b.profile === 'object' ? (b.profile as Record<string, unknown>) : null
  const profile: UserProfile | undefined = rawProfile
    ? {
        name: shortString(rawProfile.name),
        language: shortString(rawProfile.language),
        persona: shortString(rawProfile.persona),
        role: shortString(rawProfile.role),
      }
    : undefined

  const history: ChatTurn[] = (Array.isArray(b.history) ? b.history : [])
    .filter(
      (t): t is ChatTurn =>
        !!t &&
        typeof t === 'object' &&
        ((t as ChatTurn).role === 'user' || (t as ChatTurn).role === 'assistant') &&
        typeof (t as ChatTurn).content === 'string' &&
        (t as ChatTurn).content.trim() !== '',
    )
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_TURN_CHARS) }))

  // The model API wants the first turn to be the user's; a trimmed history can
  // start mid-exchange.
  while (history.length && history[0].role !== 'user') history.shift()

  return { ok: true, value: { message, walletAddress, feePayerAddress, profile, history } }
}

export async function handleChat(request: ChatRequest, llm: LlmProvider): Promise<AgentResult> {
  return runAgent(
    request.message,
    request.walletAddress,
    request.history,
    request.feePayerAddress,
    request.profile,
    llm,
  )
}

export function extractBearerToken(authorizationHeader?: string | null, body?: unknown): string {
  if (typeof authorizationHeader === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim())
    if (match?.[1]) return match[1].trim()
  }
  if (body && typeof body === 'object') {
    const token = (body as Record<string, unknown>).sessionToken
    if (typeof token === 'string' && token.trim()) return token.trim()
  }
  return ''
}

export type HttpDispatchResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 401 | 403; body: { error: string } }

export interface StatefulAgentHandler {
  auth: AgentAuthManager
  conversations: Map<string, ChatTurn[]>
  dispatch: (
    body: unknown,
    llm: LlmProvider,
    authorizationHeader?: string | null,
  ) => Promise<HttpDispatchResult>
}

export function createAgentHandler(authOptions: AgentAuthOptions = {}): StatefulAgentHandler {
  const auth = createAgentAuthManager(authOptions)
  const conversations = new Map<string, ChatTurn[]>()

  function rememberConversation(walletAddress: string, turns: ChatTurn[]): void {
    conversations.set(walletAddress, turns.slice(-MAX_HISTORY_TURNS))
    if (conversations.size > MAX_STORED_CONVERSATIONS) {
      const oldest = conversations.keys().next().value
      if (oldest !== undefined) conversations.delete(oldest)
    }
  }

  async function dispatch(
    body: unknown,
    llm: LlmProvider,
    authorizationHeader?: string | null,
  ): Promise<HttpDispatchResult> {
    if (!body || typeof body !== 'object') {
      return { status: 400, body: { error: 'Expected a JSON body' } }
    }
    const b = body as Record<string, unknown>
    const action = typeof b.action === 'string' ? b.action.trim() : 'chat'

    if (action === 'challenge') {
      const res = auth.issueChallenge(b.walletAddress)
      if (!res.ok) return { status: 400, body: { error: res.error } }
      return {
        status: 200,
        body: {
          challenge: res.challenge,
          walletAddress: res.walletAddress,
          expiresAt: res.expiresAt,
        },
      }
    }

    if (action === 'verify') {
      const res = await auth.verifyChallenge(b)
      if (!res.ok) return { status: 401, body: { error: res.error } }
      return {
        status: 200,
        body: {
          sessionToken: res.session.sessionToken,
          walletAddress: res.session.walletAddress,
          expiresAt: res.session.expiresAt,
        },
      }
    }

    // All post-auth actions ('chat', 'clear_history') require a valid session token
    // and take `walletAddress` exclusively from `session.walletAddress`.
    const token = extractBearerToken(authorizationHeader, b)
    const verified = auth.verifySession(token)
    if (!verified.ok) {
      return { status: 401, body: { error: verified.error } }
    }
    const session = verified.session

    if (action === 'clear_history') {
      conversations.delete(session.walletAddress)
      return { status: 200, body: { ok: true, type: 'history_cleared' } }
    }

    if (action !== 'chat') {
      return { status: 400, body: { error: `Unknown action: ${action}` } }
    }

    const parsed = parseChatRequest(b, session)
    if (!parsed.ok) {
      return { status: 400, body: { error: parsed.error } }
    }

    const storedHistory = conversations.get(session.walletAddress) ?? []
    const effectiveHistory = parsed.value.history.length > 0 ? parsed.value.history : [...storedHistory]

    const result = await handleChat(
      {
        ...parsed.value,
        walletAddress: session.walletAddress,
        history: effectiveHistory,
      },
      llm,
    )

    const updatedHistory: ChatTurn[] = [
      ...effectiveHistory,
      { role: 'user', content: parsed.value.message },
      { role: 'assistant', content: result.response },
    ]
    rememberConversation(session.walletAddress, updatedHistory)

    return { status: 200, body: { ...result } }
  }

  return { auth, conversations, dispatch }
}

/**
 * A fixed-window limiter keyed by caller. In-memory, so on serverless it is per
 * instance rather than global — a speed bump that stops one client hammering a
 * warm instance, not a guarantee. The model provider's own quota is the backstop.
 */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>()
  return function allow(key: string): boolean {
    const t = now()
    const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs)
    if (recent.length >= limit) {
      hits.set(key, recent)
      return false
    }
    recent.push(t)
    hits.set(key, recent)
    // Keep the map from growing without bound on a long-lived instance.
    if (hits.size > 10_000) hits.delete(hits.keys().next().value as string)
    return true
  }
}
