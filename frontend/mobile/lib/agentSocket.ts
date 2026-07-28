/**
 * WebSocket client for the Veil agent service (`packages/agent`).
 *
 * The web wallet talks to the same server straight from `app/agent/page.tsx`:
 * it opens a socket, parses `event.data` inline, and on close schedules a fixed
 * 2-second reconnect. That is adequate for a browser tab; a phone is a harsher
 * environment. Connections drop every time the app is backgrounded, the radio
 * switches between Wi-Fi and cellular, or the device sleeps, so the transport
 * is pulled out here and given the behaviour a mobile client needs:
 *
 *   - Exponential backoff with jitter, so a server that is down does not get
 *     hammered by every phone on the network in lockstep.
 *   - An outbound queue, so a message composed while the socket is down is
 *     delivered when it comes back rather than silently dropped.
 *   - In-flight accounting. The agent protocol has no request ids and no
 *     replay: a `chat` whose socket dies before the `response` arrives is gone
 *     for good. Rather than leave the UI waiting forever, the client reports
 *     how many replies were lost so the screen can say so.
 *
 * Everything the client touches from the outside world — the socket
 * constructor, the timers, the jitter — is injectable, which is what makes the
 * reconnect logic testable without a server.
 */

// ── Protocol ────────────────────────────────────────────────────────────────────

/** The user profile the server personalises replies with. Mirrors `UserProfile` in `packages/agent/src/agent.ts`. */
export type AgentUserProfile = {
  name?: string;
  language?: string;
  persona?: string;
  role?: string;
};

/** Messages the client sends. Matches the `msg.type` switch in `packages/agent/src/server.ts`. */
export type AgentClientMessage =
  | {
      type: 'chat';
      walletAddress: string;
      message: string;
      feePayerAddress?: string;
      profile?: AgentUserProfile;
    }
  | { type: 'clear_history'; walletAddress: string };

/** Messages the server sends. */
export type AgentServerMessage =
  | { type: 'thinking' }
  | { type: 'response'; message: string; pendingTxXdr?: string; pendingTxSummary?: string }
  | { type: 'error'; message: string }
  | { type: 'history_cleared' };

/**
 * Connection state, as the UI needs to describe it.
 *
 * `connecting` is the first attempt; `reconnecting` is every attempt after a
 * drop. They are distinct because they read differently to a user — one is
 * startup, the other is a problem — and only the second warrants a banner.
 */
export type AgentSocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

// ── Injectable environment ──────────────────────────────────────────────────────

/**
 * The slice of the WebSocket API this client uses. React Native's global
 * `WebSocket` satisfies it, and so does a stub in a test.
 */
export interface AgentWebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type AgentSocketOptions = {
  /** Agent server URL. Defaults to `EXPO_PUBLIC_AGENT_WS_URL`, then localhost. */
  url?: string;
  /** Every decoded server message, in arrival order. */
  onMessage?: (message: AgentServerMessage) => void;
  /** Connection state changes. Only fires when the state actually changes. */
  onStatus?: (status: AgentSocketStatus) => void;
  /**
   * Called when a drop orphaned `count` requests that had been sent but not yet
   * answered. Those replies are never coming — the server keeps no outbox.
   */
  onRequestsLost?: (count: number) => void;
  /** Socket constructor. Defaults to the global `WebSocket`. */
  createWebSocket?: (url: string) => AgentWebSocketLike;
  /** Backoff jitter source in [0, 1). Defaults to `Math.random`. */
  random?: () => number;
};

// ── Reconnect timing ────────────────────────────────────────────────────────────

/** First reconnect delay. Short enough that a blip is invisible to the user. */
export const INITIAL_RECONNECT_DELAY_MS = 1_000;

/** Ceiling for the backoff. A phone in a tunnel should still retry twice a minute. */
export const MAX_RECONNECT_DELAY_MS = 30_000;

/** Fraction of the delay that jitter can subtract, spreading out synchronised clients. */
const JITTER_RATIO = 0.25;

/**
 * Cap on queued-but-unsent messages. A user cannot usefully compose more than a
 * handful while offline, and an unbounded queue would replay a wall of stale
 * questions at the agent the moment the network returns.
 */
export const MAX_QUEUED_MESSAGES = 10;

/**
 * Delay before reconnect attempt number `attempt` (1-based), with jitter applied.
 *
 * Doubles from {@link INITIAL_RECONNECT_DELAY_MS} up to
 * {@link MAX_RECONNECT_DELAY_MS}, then subtracts up to 25% so that a fleet of
 * clients dropped by the same server restart does not return in a thundering
 * herd. Jitter only ever shortens the wait, so the cap is a true ceiling.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = INITIAL_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, MAX_RECONNECT_DELAY_MS);
  return Math.round(capped * (1 - JITTER_RATIO * random()));
}

// ── Decoding ────────────────────────────────────────────────────────────────────

/**
 * Decode a raw frame into a known server message, or null.
 *
 * Anything unrecognised — malformed JSON, a message type added to the server
 * after this client shipped — is dropped rather than thrown. A chat screen
 * should survive a stray frame, and an old build talking to a new server is a
 * normal state of affairs for an app store release.
 */
export function parseServerMessage(raw: unknown): AgentServerMessage | null {
  if (typeof raw !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const data = parsed as Record<string, unknown>;

  switch (data.type) {
    case 'thinking':
      return { type: 'thinking' };
    case 'history_cleared':
      return { type: 'history_cleared' };
    case 'response': {
      if (typeof data.message !== 'string') return null;
      const message: AgentServerMessage = { type: 'response', message: data.message };
      if (typeof data.pendingTxXdr === 'string') {
        message.pendingTxXdr = data.pendingTxXdr;
        if (typeof data.pendingTxSummary === 'string') {
          message.pendingTxSummary = data.pendingTxSummary;
        }
      }
      return message;
    }
    case 'error':
      return {
        type: 'error',
        message: typeof data.message === 'string' ? data.message : 'Unknown agent error',
      };
    default:
      return null;
  }
}

/** The agent server URL, from the Expo env with a localhost fallback for `npm run agent`. */
export function getAgentSocketUrl(): string {
  return process.env['EXPO_PUBLIC_AGENT_WS_URL']?.trim() || 'ws://localhost:3001';
}

// ── Client ──────────────────────────────────────────────────────────────────────

export interface AgentSocket {
  /** Open the connection and keep it open until {@link AgentSocket.close}. */
  connect(): void;
  /**
   * Send a message, queueing it if the socket is not open yet.
   *
   * @returns `sent` if it went out on the wire, `queued` if it is waiting for
   *   the connection, or `dropped` if the queue is full or the client is closed.
   */
  send(message: AgentClientMessage): 'sent' | 'queued' | 'dropped';
  /** Current connection state. */
  status(): AgentSocketStatus;
  /** Requests sent but not yet answered. */
  pendingRequests(): number;
  /** Close for good: no further reconnects, queue discarded. */
  close(): void;
}

/**
 * Create an agent socket. Nothing happens until {@link AgentSocket.connect} is
 * called, so a caller can wire up handlers first and connect in an effect.
 */
export function createAgentSocket(options: AgentSocketOptions = {}): AgentSocket {
  const url = options.url ?? getAgentSocketUrl();
  const random = options.random ?? Math.random;
  const createWebSocket =
    options.createWebSocket ??
    ((target: string) => new WebSocket(target) as unknown as AgentWebSocketLike);

  let socket: AgentWebSocketLike | null = null;
  let status: AgentSocketStatus = 'closed';
  let attempt = 0;
  let inFlight = 0;
  let closedByCaller = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const queue: AgentClientMessage[] = [];

  function setStatus(next: AgentSocketStatus): void {
    if (status === next) return;
    status = next;
    options.onStatus?.(next);
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function writeToSocket(active: AgentWebSocketLike, message: AgentClientMessage): void {
    active.send(JSON.stringify(message));
    // `clear_history` is answered by `history_cleared`, but it is fire-and-forget
    // as far as the UI is concerned: nothing waits on it, so it is not in flight.
    if (message.type === 'chat') inFlight += 1;
  }

  function flushQueue(active: AgentWebSocketLike): void {
    // Splice first: `writeToSocket` can throw on a socket that closed between the
    // open callback and this line, and a message must not be replayed forever.
    const pending = queue.splice(0, queue.length);
    for (const message of pending) writeToSocket(active, message);
  }

  function scheduleReconnect(): void {
    if (closedByCaller) return;
    attempt += 1;
    setStatus('reconnecting');
    clearReconnect();
    reconnectTimer = setTimeout(open, reconnectDelayMs(attempt, random));
  }

  function open(): void {
    if (closedByCaller) return;
    clearReconnect();
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

    // Each socket gets its own `settled` flag: RN can deliver `onerror` and
    // `onclose` for the same failure, and a late callback from a socket we have
    // already replaced must not schedule a second reconnect.
    let settled = false;
    let active: AgentWebSocketLike;
    try {
      active = createWebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = active;

    function settle(): void {
      if (settled) return;
      settled = true;
      // A socket we have already stopped tracking (replaced, or torn down by
      // `close`) must not drive state — its teardown was accounted for already.
      if (socket !== active) return;
      socket = null;

      // Replies for requests already on the wire will never arrive: the server
      // holds no per-connection outbox, so the UI has to stop waiting for them.
      if (inFlight > 0) {
        const lost = inFlight;
        inFlight = 0;
        options.onRequestsLost?.(lost);
      }

      if (closedByCaller) {
        setStatus('closed');
        return;
      }
      scheduleReconnect();
    }

    active.onopen = () => {
      if (settled || socket !== active) return;
      attempt = 0;
      setStatus('connected');
      flushQueue(active);
    };

    active.onmessage = (event) => {
      if (socket !== active) return;
      const message = parseServerMessage(event?.data);
      if (!message) return;
      // `thinking` is a progress ping, not an answer — the request stays in
      // flight until the `response` or `error` that ends it.
      if (message.type === 'response' || message.type === 'error') {
        inFlight = Math.max(0, inFlight - 1);
      }
      options.onMessage?.(message);
    };

    active.onerror = () => settle();
    active.onclose = () => settle();
  }

  return {
    connect(): void {
      if (closedByCaller || socket !== null || reconnectTimer !== null) return;
      open();
    },

    send(message: AgentClientMessage): 'sent' | 'queued' | 'dropped' {
      if (closedByCaller) return 'dropped';

      if (socket !== null && status === 'connected') {
        try {
          writeToSocket(socket, message);
          return 'sent';
        } catch {
          // The socket died between the status check and the write. Fall through
          // and queue it, so the reconnect delivers it instead of losing it.
        }
      }

      if (queue.length >= MAX_QUEUED_MESSAGES) return 'dropped';
      queue.push(message);
      return 'queued';
    },

    status: () => status,

    pendingRequests: () => inFlight,

    close(): void {
      closedByCaller = true;
      clearReconnect();
      queue.length = 0;
      // Zeroed before closing so the `onclose` this triggers reports no lost
      // requests: the caller is leaving, and has nothing left to be told about.
      inFlight = 0;
      const active = socket;
      setStatus('closed');
      if (active) {
        active.close();
      } else {
        socket = null;
      }
    },
  };
}
