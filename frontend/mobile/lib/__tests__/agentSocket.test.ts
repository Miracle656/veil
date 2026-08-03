import {
  createAgentSocket,
  getAgentSocketUrl,
  MAX_QUEUED_MESSAGES,
  MAX_RECONNECT_DELAY_MS,
  parseServerMessage,
  reconnectDelayMs,
  type AgentServerMessage,
  type AgentSocketStatus,
  type AgentWebSocketLike,
} from '../agentSocket';

/**
 * Stand-in for the platform WebSocket. Records what was written and exposes the
 * lifecycle callbacks so a test can drive open/message/close by hand — the
 * reconnect behaviour is the whole point of this module, and there is no way to
 * provoke it against a real server.
 */
class FakeSocket implements AgentWebSocketLike {
  static instances: FakeSocket[] = [];

  sent: string[] = [];
  closed = false;
  /** When set, `send` throws — a socket that died between the check and the write. */
  failSend = false;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.failSend) throw new Error('socket is closing');
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  /** Frame a server payload the way the agent server does. */
  deliver(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  static latest(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error('no socket was created');
    return socket;
  }

  static reset(): void {
    FakeSocket.instances = [];
  }
}

function setup() {
  const messages: AgentServerMessage[] = [];
  const statuses: AgentSocketStatus[] = [];
  const lost: number[] = [];

  const socket = createAgentSocket({
    url: 'ws://agent.test',
    createWebSocket: (url) => new FakeSocket(url),
    // Fixed jitter keeps the delays deterministic without pinning the formula.
    random: () => 0,
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    onRequestsLost: (count) => lost.push(count),
  });

  return { socket, messages, statuses, lost };
}

const CHAT = { type: 'chat', walletAddress: 'GABC', message: 'hi' } as const;

beforeEach(() => {
  FakeSocket.reset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('parseServerMessage', () => {
  it('decodes each message the agent server sends', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'thinking' }))).toEqual({ type: 'thinking' });
    expect(parseServerMessage(JSON.stringify({ type: 'history_cleared' }))).toEqual({
      type: 'history_cleared',
    });
    expect(parseServerMessage(JSON.stringify({ type: 'error', message: 'boom' }))).toEqual({
      type: 'error',
      message: 'boom',
    });
  });

  it('carries the pending transaction through a response', () => {
    const decoded = parseServerMessage(
      JSON.stringify({
        type: 'response',
        message: 'Ready to send',
        pendingTxXdr: 'AAAA',
        pendingTxSummary: 'Send 5 XLM',
      })
    );

    expect(decoded).toEqual({
      type: 'response',
      message: 'Ready to send',
      pendingTxXdr: 'AAAA',
      pendingTxSummary: 'Send 5 XLM',
    });
  });

  it('drops a summary that arrives without an XDR, so no empty approval card renders', () => {
    const decoded = parseServerMessage(
      JSON.stringify({ type: 'response', message: 'hi', pendingTxSummary: 'Send 5 XLM' })
    );

    expect(decoded).toEqual({ type: 'response', message: 'hi' });
  });

  it('returns null for junk rather than throwing into the chat screen', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'from_a_newer_server' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'response' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
  });

  it('substitutes a message for an error frame that omits one', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'error' }))).toEqual({
      type: 'error',
      message: 'Unknown agent error',
    });
  });
});

describe('reconnectDelayMs', () => {
  it('backs off exponentially and then holds at the ceiling', () => {
    const noJitter = () => 0;
    expect(reconnectDelayMs(1, noJitter)).toBe(1_000);
    expect(reconnectDelayMs(2, noJitter)).toBe(2_000);
    expect(reconnectDelayMs(3, noJitter)).toBe(4_000);
    expect(reconnectDelayMs(20, noJitter)).toBe(MAX_RECONNECT_DELAY_MS);
  });

  it('only ever shortens the wait, so the ceiling is a real ceiling', () => {
    for (const jitter of [0, 0.5, 0.99]) {
      const delay = reconnectDelayMs(3, () => jitter);
      expect(delay).toBeLessThanOrEqual(4_000);
      expect(delay).toBeGreaterThan(2_000);
    }
  });
});

describe('createAgentSocket', () => {
  it('connects and reports status', () => {
    const { socket, statuses } = setup();

    socket.connect();
    expect(FakeSocket.latest().url).toBe('ws://agent.test');
    expect(statuses).toEqual(['connecting']);

    FakeSocket.latest().onopen?.();
    expect(statuses).toEqual(['connecting', 'connected']);
    expect(socket.status()).toBe('connected');
  });

  it('sends a chat message and surfaces the reply', () => {
    const { socket, messages } = setup();
    socket.connect();
    FakeSocket.latest().onopen?.();

    expect(socket.send(CHAT)).toBe('sent');
    expect(JSON.parse(FakeSocket.latest().sent[0] as string)).toEqual(CHAT);

    FakeSocket.latest().deliver({ type: 'thinking' });
    FakeSocket.latest().deliver({ type: 'response', message: 'Your balance is 10 XLM' });

    expect(messages).toEqual([
      { type: 'thinking' },
      { type: 'response', message: 'Your balance is 10 XLM' },
    ]);
  });

  it('keeps a request in flight until it is answered', () => {
    const { socket } = setup();
    socket.connect();
    FakeSocket.latest().onopen?.();

    socket.send(CHAT);
    expect(socket.pendingRequests()).toBe(1);

    // A "thinking" ping is progress, not an answer.
    FakeSocket.latest().deliver({ type: 'thinking' });
    expect(socket.pendingRequests()).toBe(1);

    FakeSocket.latest().deliver({ type: 'response', message: 'done' });
    expect(socket.pendingRequests()).toBe(0);
  });

  it('does not count clear_history as an in-flight request', () => {
    const { socket } = setup();
    socket.connect();
    FakeSocket.latest().onopen?.();

    socket.send({ type: 'clear_history', walletAddress: 'GABC' });
    expect(socket.pendingRequests()).toBe(0);
  });

  it('reconnects after a drop, with backoff', () => {
    const { socket, statuses } = setup();
    socket.connect();
    FakeSocket.latest().onopen?.();

    FakeSocket.latest().onclose?.();
    expect(socket.status()).toBe('reconnecting');
    expect(FakeSocket.instances).toHaveLength(1);

    // Nothing happens before the backoff elapses.
    jest.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);

    jest.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.latest().onopen?.();
    expect(statuses).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
  });

  it('lengthens the delay while reconnects keep failing, and resets once one lands', () => {
    const { socket } = setup();
    socket.connect();
    FakeSocket.latest().onopen?.();

    FakeSocket.latest().onclose?.();
    jest.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);

    // Second failure waits twice as long.
    FakeSocket.latest().onclose?.();
    jest.advanceTimersByTime(1_999);
    expect(FakeSocket.instances).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    // A successful connection puts the next drop back at the first delay.
    FakeSocket.latest().onopen?.();
    FakeSocket.latest().onclose?.();
    jest.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(4);
    expect(socket.status()).toBe('reconnecting');
  });

  it('treats an error as a drop without reconnecting twice', () => {
    const { socket } = setup();
    socket.connect();
    FakeSocket.latest().onopen?.();

    // React Native can report the same failure as both an error and a close.
    const failing = FakeSocket.latest();
    failing.onerror?.(new Error('network down'));
    failing.onclose?.();

    jest.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(socket.status()).toBe('reconnecting');
  });

  it('reports requests orphaned by a drop', () => {
    const { socket, lost } = setup();
    socket.connect();
    FakeSocket.latest().onopen?.();

    socket.send(CHAT);
    socket.send(CHAT);
    FakeSocket.latest().onclose?.();

    expect(lost).toEqual([2]);
    expect(socket.pendingRequests()).toBe(0);
  });

  it('queues messages composed while offline and flushes them on reconnect', () => {
    const { socket } = setup();
    socket.connect();
    FakeSocket.latest().onopen?.();
    FakeSocket.latest().onclose?.();

    expect(socket.send(CHAT)).toBe('queued');
    expect(socket.send({ type: 'chat', walletAddress: 'GABC', message: 'still there?' })).toBe(
      'queued'
    );

    jest.advanceTimersByTime(1_000);
    const reconnected = FakeSocket.latest();
    expect(reconnected.sent).toEqual([]);

    reconnected.onopen?.();
    expect(reconnected.sent.map((raw) => JSON.parse(raw).message)).toEqual(['hi', 'still there?']);
    expect(socket.pendingRequests()).toBe(2);
  });

  it('queues rather than loses a message whose write fails mid-send', () => {
    const { socket } = setup();
    socket.connect();
    FakeSocket.latest().onopen?.();

    FakeSocket.latest().failSend = true;
    expect(socket.send(CHAT)).toBe('queued');

    FakeSocket.latest().onclose?.();
    jest.advanceTimersByTime(1_000);
    FakeSocket.latest().onopen?.();

    expect(FakeSocket.latest().sent).toHaveLength(1);
  });

  it('drops messages past the queue cap instead of replaying a backlog', () => {
    const { socket } = setup();
    socket.connect();
    FakeSocket.latest().onclose?.();

    for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) {
      expect(socket.send(CHAT)).toBe('queued');
    }
    expect(socket.send(CHAT)).toBe('dropped');
  });

  it('stops reconnecting once closed by the caller', () => {
    const { socket, statuses, lost } = setup();
    socket.connect();
    FakeSocket.latest().onopen?.();
    socket.send(CHAT);

    socket.close();

    expect(FakeSocket.latest().closed).toBe(true);
    expect(socket.status()).toBe('closed');
    // Leaving the screen is not a lost reply worth reporting to a gone user.
    expect(lost).toEqual([]);

    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(statuses[statuses.length - 1]).toBe('closed');
    expect(socket.send(CHAT)).toBe('dropped');
  });

  it('cancels a scheduled reconnect when closed mid-backoff', () => {
    const { socket } = setup();
    socket.connect();
    FakeSocket.latest().onclose?.();

    socket.close();
    jest.advanceTimersByTime(60_000);

    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('retries when the socket constructor itself throws', () => {
    let attempts = 0;
    const socket = createAgentSocket({
      url: 'ws://agent.test',
      random: () => 0,
      createWebSocket: (url) => {
        attempts += 1;
        if (attempts === 1) throw new Error('no network');
        return new FakeSocket(url);
      },
    });

    socket.connect();
    expect(socket.status()).toBe('reconnecting');

    jest.advanceTimersByTime(1_000);
    expect(attempts).toBe(2);
    expect(socket.status()).toBe('reconnecting');

    FakeSocket.latest().onopen?.();
    expect(socket.status()).toBe('connected');
  });

  it('ignores a second connect while one is already in progress', () => {
    const { socket } = setup();
    socket.connect();
    socket.connect();

    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('getAgentSocketUrl', () => {
  const original = process.env['EXPO_PUBLIC_AGENT_WS_URL'];

  afterEach(() => {
    if (original === undefined) delete process.env['EXPO_PUBLIC_AGENT_WS_URL'];
    else process.env['EXPO_PUBLIC_AGENT_WS_URL'] = original;
  });

  it('prefers the configured URL and falls back to the local dev server', () => {
    process.env['EXPO_PUBLIC_AGENT_WS_URL'] = ' wss://agent.veil.app ';
    expect(getAgentSocketUrl()).toBe('wss://agent.veil.app');

    delete process.env['EXPO_PUBLIC_AGENT_WS_URL'];
    expect(getAgentSocketUrl()).toBe('ws://localhost:3001');
  });
});
