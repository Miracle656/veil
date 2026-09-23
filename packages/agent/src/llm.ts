import Anthropic from '@anthropic-ai/sdk'

/**
 * The model behind the agent, behind one small interface.
 *
 * Two providers:
 *
 * - **Anthropic** (default when an Anthropic credential is present): Claude via
 *   the official SDK. Best tool use; paid.
 * - **OpenRouter** (when `OPENROUTER_API_KEY` is set): free open-weight models
 *   through OpenRouter's chat-completions API, with automatic failover across
 *   several models, because the free list changes daily and any one model can
 *   vanish or be overloaded. Free tier: 20 requests/minute, and 50 a day — 1,000 a
 *   day once $10 of credit has been bought. A chat turn costs 2–4 requests.
 *
 * Each provider keeps its own native message list for the turn, so nothing is
 * lost in translation — Claude's thinking and fallback blocks go back exactly as
 * they came, and OpenRouter's tool calls keep their ids.
 */

/** A tool definition, in the JSON-Schema shape both providers accept. */
export type ToolSpec = Anthropic.Tool

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface LlmTurn {
  /** Text the model produced this turn (may be empty when it only calls tools). */
  text: string
  /** Tools it wants run. Empty means the turn is finished. */
  toolCalls: ToolCall[]
}

/** Earlier turns, as plain text — what the server keeps per wallet. */
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** One user message's worth of conversation with the model. */
export interface LlmSession {
  next(): Promise<LlmTurn>
  addToolResults(results: { id: string; content: string }[]): void
}

export interface LlmProvider {
  /** For logs and /health — which provider and model(s) answer. */
  readonly label: string
  start(system: string, history: ChatTurn[], userMessage: string, tools: ToolSpec[]): LlmSession
}

// ── Anthropic ────────────────────────────────────────────────────────────────

/**
 * Claude Opus 5 unless CLAUDE_MODEL says otherwise. Thinking is on by default on
 * this model, which is why max_tokens is 16,000: thinking shares the output
 * budget, and the old 1,024 would cut a turn off before its tool call.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5'

/** Where a declined request is re-run. Only used when the primary model refuses. */
const CLAUDE_FALLBACK_MODEL = 'claude-opus-4-8'

export function anthropicProvider(options: { apiKey?: string; model?: string } = {}): LlmProvider {
  const client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {})
  const model = options.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL

  return {
    label: `anthropic:${model}`,
    start(system, history, userMessage, tools) {
      const messages: Anthropic.Beta.BetaMessageParam[] = [
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: userMessage },
      ]

      return {
        async next() {
          for (;;) {
            const response = await client.beta.messages.create({
              model,
              max_tokens: 16_000,
              // If a safety classifier declines, the API re-runs the request on
              // the fallback model instead of refusing. The array form, because
              // the pinned SDK (0.113) types only this form; the newer
              // `fallbacks: 'default'` needs a newer SDK.
              betas: ['server-side-fallback-2026-06-01'],
              fallbacks: [{ model: CLAUDE_FALLBACK_MODEL }],
              system,
              tools,
              messages,
            })

            // The full content goes back — thinking and fallback blocks included.
            messages.push({ role: 'assistant', content: response.content })

            // A server-side pause: re-send so the model can carry on.
            if (response.stop_reason === 'pause_turn') continue

            if (response.stop_reason === 'refusal') {
              return {
                text: "I can't help with that request. Try rephrasing what you need.",
                toolCalls: [],
              }
            }

            const text = response.content
              .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('')

            // Hitting max_tokens mid-tool-call leaves an incomplete call; do not run it.
            if (response.stop_reason !== 'tool_use') return { text, toolCalls: [] }

            const toolCalls = response.content
              .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
              .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }))
            return { text, toolCalls }
          }
        },

        addToolResults(results) {
          // All results in one user message: splitting them teaches the model to
          // stop making parallel calls.
          messages.push({
            role: 'user',
            content: results.map((r) => ({
              type: 'tool_result' as const,
              tool_use_id: r.id,
              content: r.content,
            })),
          })
        },
      }
    },
  }
}

// ── OpenRouter (OpenAI-compatible chat completions) ──────────────────────────

/**
 * Free models that support tool calling, checked 2026-09-22 against
 * `openrouter.ai/api/v1/models` (19 of 21 free models did). Order is preference;
 * OpenRouter falls through the list when one is down or rate-limited. The free
 * catalogue changes daily — override with AGENT_MODELS rather than editing this.
 */
export const DEFAULT_FREE_MODELS = [
  'qwen/qwen3.8-27b:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-26b-a4b-it:free',
]

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export function openRouterProvider(options: { apiKey: string; models?: string[] }): LlmProvider {
  const models = options.models?.length ? options.models : DEFAULT_FREE_MODELS

  return {
    label: `openrouter:${models.join(',')}`,
    start(system, history, userMessage, tools) {
      const messages: OpenAiMessage[] = [
        { role: 'system', content: system },
        ...history.map((t) => ({ role: t.role, content: t.content }) as OpenAiMessage),
        { role: 'user', content: userMessage },
      ]
      const functions = tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description ?? '', parameters: t.input_schema },
      }))

      return {
        async next() {
          const body = await completeWithFallback(options.apiKey, models, {
            messages,
            tools: functions,
            tool_choice: 'auto',
            max_tokens: 4_096,
            // Keep reasoning models from spending the whole budget on thinking.
            // OpenRouter maps this per model and ignores it where unsupported.
            reasoning: { effort: 'low' },
          })

          const message = body?.choices?.[0]?.message ?? {}
          const rawCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : []
          messages.push({
            role: 'assistant',
            content: message.content ?? null,
            ...(rawCalls.length ? { tool_calls: rawCalls } : {}),
          })

          const toolCalls: ToolCall[] = rawCalls.map((c) => {
            let input: Record<string, unknown> = {}
            try {
              input = JSON.parse(c?.function?.arguments || '{}')
            } catch {
              // Malformed arguments from a weaker model: let the tool report it
              // rather than guessing what was meant.
              input = { __invalid_arguments: c?.function?.arguments ?? '' }
            }
            return { id: String(c.id), name: String(c?.function?.name ?? ''), input }
          })

          return { text: typeof message.content === 'string' ? message.content : '', toolCalls }
        },

        addToolResults(results) {
          for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.content })
        },
      }
    },
  }
}

/**
 * Whether an error came from the model's provider rather than from OpenRouter
 * itself. OpenRouter passes a provider's failure through as "Provider returned
 * error" with the provider named in metadata — a 429 there is that provider being
 * saturated, which says nothing about the next model. Its own account limit
 * carries neither.
 */
function isUpstreamFailure(body: any): boolean {
  return !!body?.error?.metadata?.provider_name || /provider returned error/i.test(String(body?.error?.message ?? ''))
}

/** Statuses that mean "this model, right now" rather than "this request". */
const TRY_NEXT_MODEL = new Set([404, 408, 502, 503, 504])

/**
 * One chat completion, trying each model in turn.
 *
 * Every free model is served by a single provider, so any one of them can be
 * overloaded (503) or withdrawn (404) at any moment. This used to send the list
 * as OpenRouter's `models` fallback in one request; when that returned 503 the
 * whole turn failed, and the error kept only the status code. Now each model is
 * tried separately, the provider's own message is kept for the server log, and
 * only failures that are about the model move on to the next one.
 *
 * A 429 from OpenRouter itself is the account's rate limit — the next model
 * would hit the same limit — so it stops at once; a 429 passed through from a
 * model's provider moves on. 401/402 are configuration and stop, too.
 */
async function completeWithFallback(
  apiKey: string,
  models: string[],
  payload: Record<string, unknown>,
): Promise<any> {
  const failures: string[] = []
  // Free models are shared by everyone on OpenRouter, so at busy moments every
  // one of them can be rate-limited at once — seen in production with all five
  // failing together. Those limits clear in seconds, so the whole list is tried
  // again after a short wait before the turn is given up on.
  for (let pass = 0; pass < 2; pass++) {
    if (pass > 0) {
      if (!failures.some((f) => / 429 | 503 /.test(f))) break
      await new Promise((r) => setTimeout(r, 2_000))
    }
    const result = await tryModels(apiKey, models, payload, failures)
    if (result) return result
  }
  throw new Error(`Model provider error: ${failures.join(' | ')}`)
}

async function tryModels(
  apiKey: string,
  models: string[],
  payload: Record<string, unknown>,
  failures: string[],
): Promise<any | null> {
  for (const model of models) {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Attribution OpenRouter asks for; shows on their app rankings.
        'HTTP-Referer': 'https://www.useveilapp.xyz',
        'X-Title': 'Veil Agent',
      },
      body: JSON.stringify({ ...payload, model }),
      // Per model, so trying several still fits inside the route's 60s limit.
      signal: AbortSignal.timeout(20_000),
    })

    const body = (await res.json().catch(() => ({}))) as any
    if (res.ok && !body?.error) {
      const choice = body?.choices?.[0]
      const hasTools = Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0
      const hasText = typeof choice?.message?.content === 'string' && choice.message.content.trim() !== ''
      if (hasTools || hasText) return body
      // Free reasoning models can spend the whole budget thinking and return an
      // empty answer. That is this model failing, not the turn: try the next.
      failures.push(`${model} → empty reply (finish_reason ${choice?.finish_reason ?? 'unknown'})`)
      continue
    }

    const status = Number(body?.error?.code ?? res.status)
    const detail = String(body?.error?.message ?? res.statusText ?? '').slice(0, 300)
    const upstream = body?.error?.metadata?.provider_name
    const raw = String(body?.error?.metadata?.raw ?? '').slice(0, 200)
    failures.push(`${model} → ${status} ${detail}${upstream ? ` [${upstream}]` : ''}${raw ? ` ${raw}` : ''}`)

    if (status === 429 && !isUpstreamFailure(body)) {
      // The account's own limit (e.g. free-models-per-day): every model shares it.
      console.error('[agent] OpenRouter account rate limit:', detail)
      throw new Error('The assistant is busy right now. Try again in a minute.')
    }
    // An upstream provider's 429 is about that one model; the next may be free.
    if (status !== 429 && !TRY_NEXT_MODEL.has(status)) break
  }
  // Nothing answered this pass. The caller decides whether to try again; the
  // failures it collected go to the server log, never to the user.
  return null
}

// ── Selection ────────────────────────────────────────────────────────────────

/**
 * The provider for this deployment, from the environment.
 *
 * LLM_PROVIDER=anthropic|openrouter forces a choice. Otherwise OpenRouter is
 * used when OPENROUTER_API_KEY is set, and Claude when it is not.
 */
export function providerFromEnv(): LlmProvider {
  const forced = process.env.LLM_PROVIDER?.trim().toLowerCase()
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim()

  if (forced === 'openrouter' || (!forced && openRouterKey)) {
    if (!openRouterKey) throw new Error('LLM_PROVIDER=openrouter needs OPENROUTER_API_KEY')
    const models = process.env.AGENT_MODELS?.split(',').map((m) => m.trim()).filter(Boolean)
    return openRouterProvider({ apiKey: openRouterKey, models })
  }
  return anthropicProvider()
}
