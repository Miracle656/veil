/**
 * Talking to the Veil agent: one HTTPS request per message.
 *
 * This replaced a WebSocket client (reconnect with backoff, a send queue) that
 * talked to an always-on agent server on its own host. The agent now runs as a
 * serverless route inside the web wallet's deployment, which cannot hold a
 * socket — so each message is a POST that carries the recent conversation and
 * gets the reply back. A dropped connection is now just a failed request the
 * user can resend; there is no socket to lose when the app is backgrounded.
 */

import type { AgentMessage, SwapIntent } from './agentMessages';

/** Who the agent is talking to. Stored by lib/agentProfile.ts. */
export type AgentUserProfile = {
  name?: string;
  language?: string;
  persona?: string;
  role?: string;
};

/** The hosted route. EXPO_PUBLIC_AGENT_URL overrides it, e.g. for a preview deploy. */
export const PRODUCTION_AGENT_URL = 'https://app.useveilapp.xyz/api/agent';

/**
 * Where to send messages. A plain http:// URL is only accepted for a local
 * machine: requests carry wallet addresses and replies carry transactions.
 */
export function resolveAgentUrl(configured: string | undefined): string {
  const url = configured?.trim();
  if (!url) return PRODUCTION_AGENT_URL;
  try {
    const parsed = new URL(url);
    const local = ['localhost', '127.0.0.1', '10.0.2.2'].includes(parsed.hostname) ||
      /^(192\.168|10)\./.test(parsed.hostname);
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local)) return url;
  } catch {
    // fall through
  }
  return PRODUCTION_AGENT_URL;
}

export function getAgentUrl(): string {
  return resolveAgentUrl(process.env['EXPO_PUBLIC_AGENT_URL']);
}

export type AgentTurn = { role: 'user' | 'assistant'; content: string };

/**
 * The conversation so far, as the agent should see it. Errors and app notices
 * are this device's own messages, not part of the conversation, so they stay out.
 */
export function historyFromMessages(messages: AgentMessage[]): AgentTurn[] {
  const turns: AgentTurn[] = [];
  for (const message of messages) {
    if (message.kind === 'user') turns.push({ role: 'user', content: message.text });
    else if ((message.kind === 'agent' || message.kind === 'proposal' || message.kind === 'swap') && message.text.trim()) {
      turns.push({ role: 'assistant', content: message.text });
    }
  }
  return turns;
}

export type AgentReply = {
  response: string;
  pendingTxXdr?: string;
  pendingTxSummary?: string;
  swapIntent?: SwapIntent;
};

/**
 * A swap hand-off from the server, or undefined when it is not one this app can
 * open. Only short ticker codes and a plain positive amount get through — the
 * Swap screen checks again, but nothing malformed should reach navigation.
 */
export function parseSwapIntent(value: unknown): SwapIntent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const code = (c: unknown) =>
    typeof c === 'string' && /^[A-Z0-9]{1,12}$/.test(c) ? c : undefined;
  const from = code(v.from);
  const to = code(v.to);
  if (!from || !to || from === to) return undefined;
  const amount =
    typeof v.amount === 'string' && /^\d+(\.\d{1,7})?$/.test(v.amount) && Number(v.amount) > 0
      ? v.amount
      : undefined;
  return { from, to, ...(amount ? { amount } : {}) };
}

export type AgentRequest = {
  message: string;
  walletAddress: string;
  feePayerAddress?: string;
  profile?: AgentUserProfile;
  history: AgentTurn[];
};

/**
 * Longer than the route's own 60s limit, so the server always answers — with a
 * reply or an error — before this device gives up on it.
 */
const TIMEOUT_MS = 70_000;

export async function sendAgentMessage(
  request: AgentRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(getAgentUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Partial<AgentReply> & { error?: string };
    if (!res.ok) {
      throw new Error(data.error ?? `The agent could not answer (${res.status}).`);
    }
    return {
      response: typeof data.response === 'string' ? data.response : '',
      pendingTxXdr: typeof data.pendingTxXdr === 'string' ? data.pendingTxXdr : undefined,
      pendingTxSummary: typeof data.pendingTxSummary === 'string' ? data.pendingTxSummary : undefined,
      swapIntent: parseSwapIntent((data as { swapIntent?: unknown }).swapIntent),
    };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error('The agent took too long to answer. Try again.');
    }
    if (err instanceof TypeError) {
      throw new Error("Couldn't reach the agent. Check your connection and try again.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
