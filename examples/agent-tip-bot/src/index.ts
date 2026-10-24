
/**
 * Veil AI Tipping Agent
 *
 * Scrapes creator posts, scores them, and tips creators whose posts exceed a
 * configurable threshold — all driven by Claude via @veil/agent tool-calling.
 *
 * The session key is a funded Stellar keypair stored in SESSION_KEY_SECRET.
 * It acts as a pre-authorised spend cap: the agent may tip up to SPEND_CAP_XLM
 * total per run without any further human interaction.
 */

import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import { fetchPosts, type Post } from './posts.js'
import { scorePost, type ScoreResult } from './scorer.js'
import { createSessionKey, sendTip, type SessionKey } from './sessionKey.js'

// ── Config ────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required')

const SESSION_KEY_SECRET = process.env.SESSION_KEY_SECRET
if (!SESSION_KEY_SECRET) throw new Error('SESSION_KEY_SECRET is required')

const SPEND_CAP_XLM = parseFloat(process.env.SPEND_CAP_XLM ?? '10')
const SCORE_THRESHOLD = parseInt(process.env.SCORE_THRESHOLD ?? '70', 10)
const TIP_AMOUNT_XLM = parseFloat(process.env.TIP_AMOUNT_XLM ?? '1')

// Conservative by default: never reveal the amount on a lock screen.
type NotificationPrefs = {
  revealAmount: boolean
}

// ── Push notification registry ───────────────────────────────────────────────
//
// A push token is registered per wallet address, only with explicit consent,
// and can be revoked at any time. Tokens and addresses are never logged: the
// registry is keyed by a salted hash of the address so that even an accidental
// dump of the map cannot be correlated back to a person.
//
// The real Expo push delivery lives in the wallet backend; this module owns the
// consent/revocation lifecycle and the redaction policy so that the agent loop
// can be exercised end-to-end without leaking amounts or addresses.

export type PushRegistration = {
  // Salted hash of the wallet address. Never the address itself.
  addressHash: string
  // Expo push token. Treated as a secret; never logged.
  expoPushToken: string
  // User's explicit consent, captured at registration time.
  consentedAt: number
  // Per-wallet notification preferences. Conservative by default.
  prefs: NotificationPrefs
}

const pushRegistry = new Map<string, PushRegistration>()

function hashAddress(address: string): string {
  // Deterministic, non-reversible key. The salt is process-local so a leaked
  // registry cannot be rainbow-tabled against known addresses.
  const salt = process.env.NOTIFY_ADDRESS_SALT ?? 'veil-notify-v1'
  let h = 0
  const input = `${salt}:${address}`
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0
  }
  return `h${(h >>> 0).toString(16)}`
}

/**
 * Register a push token for a wallet address. Requires explicit consent.
 * Returns the registration key (a hash), never the address or token.
 */
export function registerPushToken(
  address: string,
  expoPushToken: string,
  consent: boolean,
  prefs: Partial<NotificationPrefs> = {},
): string {
  if (!consent) {
    throw new Error('Push notification registration requires explicit consent')
  }
  if (!expoPushToken) {
    throw new Error('An Expo push token is required')
  }
  const addressHash = hashAddress(address)
  pushRegistry.set(addressHash, {
    addressHash,
    expoPushToken,
    consentedAt: Date.now(),
    // Conservative default: never reveal the amount unless opted in.
    prefs: { revealAmount: prefs.revealAmount === true },
  })
  return addressHash
}

/**
 * Revoke a previously registered push token. After this call the address will
 * no longer receive pushes.
 */
export function revokePushToken(address: string): boolean {
  return pushRegistry.delete(hashAddress(address))
}

/**
 * Deliver an incoming-payment notification for a wallet address.
 *
 * The payload is built from the registration's own preferences, not from the
 * caller's, so a sender cannot force an amount to be revealed. When
 * `revealAmount` is false (the default) the notification says only that funds
 * arrived.
 */
async function notifyIncomingPayment(
  to: string,
  amountXlm: number,
  _prefs: NotificationPrefs,
): Promise<void> {
  const reg = pushRegistry.get(hashAddress(to))
  if (!reg) return // No consent on file: never push.

  const body = reg.prefs.revealAmount
    ? `You received ${amountXlm} XLM`
    : 'You received funds'

  // Never log the token, the address, or the amount. The push payload is the
  // only place the (already-redacted) body leaves this process.
  const payload = {
    to: reg.expoPushToken,
    title: 'Veil',
    body,
    data: { kind: 'incoming_payment' },
  }

  const endpoint = process.env.EXPO_PUSH_ENDPOINT ?? 'https://exp.host/--/api/v2/push/send'
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`Push delivery failed with status ${res.status}`)
  }
}

const NOTIFICATION_PREFS: NotificationPrefs = {
  revealAmount: process.env.NOTIFY_REVEAL_AMOUNT === 'true',
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: 'fetch_posts',
    description:
      'Fetch the latest creator posts to evaluate for tipping. ' +
      'Returns a list of posts with engagement metrics.',
    input_schema: {
      type: 'object' as const,
      properties: {
        creator: {
          type: 'string',
          description: 'Optional creator handle to filter by. Omit to fetch all.',
        },
      },
      required: [],
    },
  },
  {
    name: 'score_post',
    description:
      'Score a single post on a 0–100 scale based on engagement, content quality, ' +
      'and originality. Returns the score and a breakdown of contributing factors.',
    input_schema: {
      type: 'object' as const,
      properties: {
        post_id: { type: 'string', description: 'The post ID to score.' },
      },
      required: ['post_id'],
    },
  },
  {
    name: 'pay',
    description:
      'Send an XLM tip to a creator\'s Stellar address. ' +
      `Only call this when a post\'s score is at or above ${SCORE_THRESHOLD}. ` +
      `Each tip is ${TIP_AMOUNT_XLM} XLM. ` +
      `The session key enforces a spend cap of ${SPEND_CAP_XLM} XLM total for this run — ` +
      'if the cap is exhausted the call will fail.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to_address: {
          type: 'string',
          description: 'Recipient Stellar address (G...).',
        },
        amount_xlm: {
          type: 'number',
          description: `Tip amount in XLM. Use exactly ${TIP_AMOUNT_XLM}.`,
        },
        memo: {
          type: 'string',
          description: 'Short memo explaining the tip (max 28 chars).',
        },
      },
      required: ['to_address', 'amount_xlm', 'memo'],
    },
  },
]

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  postCache: Map<string, Post>,
  session: SessionKey,
): Promise<string> {
  switch (name) {
    case 'fetch_posts': {
      const posts = await fetchPosts(input.creator as string | undefined)
      for (const p of posts) postCache.set(p.id, p)
      return JSON.stringify(posts.map(p => ({
        id: p.id,
        creator: p.creator,
        creatorAddress: p.creatorAddress,
        content: p.content.slice(0, 120) + (p.content.length > 120 ? '…' : ''),
        likes: p.likes,
        reposts: p.reposts,
        replies: p.replies,
      })))
    }

    case 'score_post': {
      const post = postCache.get(input.post_id as string)
      if (!post) return JSON.stringify({ error: `Post ${input.post_id} not found. Call fetch_posts first.` })
      const result: ScoreResult = scorePost(post)
      return JSON.stringify(result)
    }

    case 'pay': {
      try {
        const tip = await sendTip(
          session,
          input.to_address as string,
          input.amount_xlm as number,
          input.memo as string,
        )
        // Fire-and-forget: notify the recipient wallet that funds arrived.
        // Never log the token or the recipient address here.
        void notifyIncomingPayment(tip.to, tip.amountXlm, NOTIFICATION_PREFS).catch(
          () => {
            // Notification failures must not fail the tip.
          },
        )
        return JSON.stringify({
          status: 'sent',
          transactionHash: tip.transactionHash,
          amountXlm: tip.amountXlm,
          to: tip.to,
          remainingCapXlm: (session.spendCapXlm - session.spentXlm).toFixed(2),
        })
      } catch (err) {
        return JSON.stringify({ error: (err as Error).message })
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` })
  }
}

// ── Agent loop ────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  const session = createSessionKey(SESSION_KEY_SECRET!, SPEND_CAP_XLM)
  const postCache = new Map<string, Post>()

  const systemPrompt = `\
You are an autonomous AI tipping agent for the Veil wallet on Stellar testnet.

Your job:
1. Call fetch_posts to retrieve the latest creator posts.
2. Call score_post for each post to evaluate its quality (0–100).
3. For every post scoring ${SCORE_THRESHOLD} or above, call pay to send a tip of ${TIP_AMOUNT_XLM} XLM to the creator.
4. Do NOT tip the same creator twice in one run.
5. Stop when you have processed all posts or the spend cap (${SPEND_CAP_XLM} XLM) is exhausted.
6. At the end, print a concise summary: how many posts evaluated, how many tipped, total XLM sent, and any errors.

Be systematic: fetch first, then score each post, then tip the qualifying ones.`

  const userMessage =
    `Run the tipping cycle now. Score threshold: ${SCORE_THRESHOLD}/100. ` +
    `Tip amount: ${TIP_AMOUNT_XLM} XLM. Spend cap: ${SPEND_CAP_XLM} XLM.`

  console.log('=== Veil AI Tipping Agent ===')
  console.log(`Spend cap: ${SPEND_CAP_XLM} XLM | Threshold: ${SCORE_THRESHOLD}/100 | Tip: ${TIP_AMOUNT_XLM} XLM`)
  // Do not log the session public key: it is correlatable to the agent's funds.
  console.log('Session key: [redacted]')
  console.log()

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ]

  let response = await client.messages.create({
    model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    tools,
    messages,
  })

  while (response.stop_reason === 'tool_use') {
    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    )

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of toolBlocks) {
      console.log(`→ ${block.name}(${JSON.stringify(block.input)})`)
      let content: string
      try {
        content = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          postCache,
          session,
        )
      } catch (err) {
        content = JSON.stringify({ error: (err as Error).message })
      }

      const parsed = JSON.parse(content)
      if (block.name === 'pay') {
        if (parsed.status === 'sent') {
          // Redact recipient address from logs; keep amount and tx hash for ops.
          console.log(`  ✓ Tipped ${parsed.amountXlm} XLM → [redacted] (tx: ${parsed.transactionHash})`)
        } else {
          console.log(`  ✗ Tip failed: ${parsed.error}`)
        }
      } else if (block.name === 'score_post') {
        console.log(`  Score: ${parsed.score}/100 (${parsed.reason})`)
      }

      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content })
    }

    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })

    response = await client.messages.create({
      model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    })
  }

  const summary = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')

  console.log()
  console.log('=== Summary ===')
  console.log(summary)
  console.log()
  console.log(`Total XLM spent: ${session.spentXlm.toFixed(2)} / ${session.spendCapXlm} XLM`)
}

run().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
