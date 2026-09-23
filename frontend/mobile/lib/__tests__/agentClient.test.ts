import {
  PRODUCTION_AGENT_URL,
  historyFromMessages,
  parseSwapIntent,
  resolveAgentUrl,
  sendAgentMessage,
} from '../agentClient';
import type { AgentMessage } from '../agentMessages';

/**
 * The Agent tab's transport: one HTTPS request per message to the wallet's
 * /api/agent route, replacing a WebSocket to a separate server.
 */

describe('resolveAgentUrl', () => {
  it('uses the hosted route when nothing is configured', () => {
    expect(resolveAgentUrl(undefined)).toBe(PRODUCTION_AGENT_URL);
    expect(PRODUCTION_AGENT_URL.startsWith('https://')).toBe(true);
  });

  it('accepts https anywhere and plain http only for local development hosts', () => {
    expect(resolveAgentUrl('https://preview.example.com/api/agent')).toBe('https://preview.example.com/api/agent');
    expect(resolveAgentUrl('http://10.0.2.2:3000/api/agent')).toBe('http://10.0.2.2:3000/api/agent');
    expect(resolveAgentUrl('http://agent.example.com/api/agent')).toBe(PRODUCTION_AGENT_URL);
    expect(resolveAgentUrl('not a url')).toBe(PRODUCTION_AGENT_URL);
  });
});

describe('historyFromMessages', () => {
  it("sends the conversation, not this device's own errors and notices", () => {
    const messages: AgentMessage[] = [
      { id: '1', kind: 'agent', text: 'Hi!' },
      { id: '2', kind: 'user', text: 'Balance?' },
      { id: '3', kind: 'error', text: "Couldn't reach the agent." },
      { id: '4', kind: 'notice', text: 'Conversation cleared.' },
      {
        id: '5',
        kind: 'proposal',
        text: 'Here is the payment.',
        claim: 'Send 1 XLM',
        xdr: 'AAAA',
        review: null,
        reviewError: null,
        status: { state: 'awaiting' },
      },
    ];
    expect(historyFromMessages(messages)).toEqual([
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'Balance?' },
      { role: 'assistant', content: 'Here is the payment.' },
    ]);
  });
});

describe('sendAgentMessage', () => {
  const request = { message: 'hi', walletAddress: 'C', history: [] };
  const respond = (status: number, body: unknown) =>
    jest.fn(async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;

  it('returns the reply and a proposed transaction', async () => {
    const reply = await sendAgentMessage(
      request,
      respond(200, { response: 'Approve it', pendingTxXdr: 'AAAA', pendingTxSummary: 'Send 1 XLM' }),
    );
    expect(reply).toEqual({ response: 'Approve it', pendingTxXdr: 'AAAA', pendingTxSummary: 'Send 1 XLM' });
  });

  it('drops a transaction field that is not a string rather than passing it on', async () => {
    const reply = await sendAgentMessage(request, respond(200, { response: 'hi', pendingTxXdr: { evil: true } }));
    expect(reply.pendingTxXdr).toBeUndefined();
  });

  it("surfaces the route's own error message", async () => {
    await expect(sendAgentMessage(request, respond(429, { error: 'Too many messages.' }))).rejects.toThrow(
      'Too many messages.',
    );
  });

  it('turns a network failure into something a person can act on', async () => {
    const offline = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    await expect(sendAgentMessage(request, offline)).rejects.toThrow(/Check your connection/);
  });
});

describe('parseSwapIntent', () => {
  it('accepts a swap hand-off', () => {
    expect(parseSwapIntent({ from: 'XLM', to: 'USDC', amount: '10' })).toEqual({ from: 'XLM', to: 'USDC', amount: '10' });
    expect(parseSwapIntent({ from: 'XLM', to: 'USDC' })).toEqual({ from: 'XLM', to: 'USDC' });
  });

  it('drops anything that should not reach navigation', () => {
    expect(parseSwapIntent({ from: 'XLM', to: 'XLM' })).toBeUndefined();
    expect(parseSwapIntent({ from: '../settings', to: 'USDC' })).toBeUndefined();
    expect(parseSwapIntent({ from: 'XLM', to: 'USDC', amount: '-1' })).toEqual({ from: 'XLM', to: 'USDC' });
    expect(parseSwapIntent('XLM→USDC')).toBeUndefined();
  });
});
