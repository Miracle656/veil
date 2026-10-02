import { runAgent, type AgentResult, type UserProfile } from './agent.js'
import type { ChatTurn, LlmProvider } from './llm.js'

/**
 * One chat request, over plain HTTP.
 *
 * The agent used to be a long-lived WebSocket server that kept each wallet's
 * conversation in memory, which needed an always-on host of its own. Serverless
 * functions (the wallet's Vercel deployment) cannot hold a socket or remember
 * anything between calls, so each request now carries the recent conversation
 * itself and gets one answer back. That also removed a problem: the server no
 * longer keeps anyone's history keyed by an address anyone could claim.
 *
 * Framework-free on purpose, so the Next.js route stays a thin wrapper and this
 * is testable without one.
 */

/** Turns of earlier conversation the model sees. Older turns are dropped. */
export const MAX_HISTORY_TURNS = 20
export const MAX_MESSAGE_CHARS = 2_000
const MAX_TURN_CHARS = 4_000
const MAX_PROFILE_FIELD_CHARS = 80

const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/
const STELLAR_ADDRESS = /^[GC][A-Z2-7]{55}$/

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
 * Validates and bounds a request body. Everything here arrived from a client and
 * is treated as untrusted: the history in particular is replayed to the model,
 * so it is capped in turns and length and anything malformed is dropped rather
 * than passed on.
 */
export function parseChatRequest(body: unknown): ParseResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Expected a JSON body' }
  const b = body as Record<string, unknown>

  const message = typeof b.message === 'string' ? b.message.trim() : ''
  if (!message) return { ok: false, error: 'message is required' }
  if (message.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `message is longer than ${MAX_MESSAGE_CHARS} characters` }
  }

  const walletAddress = typeof b.walletAddress === 'string' ? b.walletAddress.trim() : ''
  if (!STELLAR_ADDRESS.test(walletAddress)) return { ok: false, error: 'walletAddress is not a Stellar address' }

  let feePayerAddress: string | undefined
  if (b.feePayerAddress !== undefined && b.feePayerAddress !== null && b.feePayerAddress !== '') {
    if (typeof b.feePayerAddress !== 'string' || !STELLAR_ACCOUNT.test(b.feePayerAddress.trim())) {
      return { ok: false, error: 'feePayerAddress is not a Stellar account' }
    }
    feePayerAddress = b.feePayerAddress.trim()
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
