import {
  BillsError,
  type AirtimeOrder,
  type BillsErrorCode,
  type BillsProvider,
  type OrderResult,
  type OrderState,
} from './types.js';

const DEFAULT_BASE = 'https://ebills.africa/wp-json';

/**
 * Tokens are valid for seven days. Refresh well inside that, because the cost
 * of an early refresh is one request and the cost of a late one is a failed
 * vend.
 */
const TOKEN_TTL_MS = 5 * 24 * 60 * 60 * 1000;

/** eBills order statuses, mapped onto states we can act on. */
const STATE_BY_STATUS: Record<string, OrderState> = {
  'completed-api': 'delivered',
  'processing-api': 'pending',
  'queued-api': 'pending',
  'initiated-api': 'pending',
  pending: 'pending',
  'on-hold': 'pending',
  refunded: 'refunded',
  cancelled: 'failed',
  failed: 'failed',
};

const ERROR_BY_CODE: Record<string, BillsErrorCode> = {
  jwt_auth_failed: 'auth_failed',
  jwt_auth_invalid_token: 'auth_failed',
  rest_forbidden: 'forbidden',
  insufficient_funds: 'insufficient_float',
  rate_limit_exceeded: 'busy',
  wallet_busy: 'busy',
  duplicate_request: 'duplicate',
  duplicate_request_id: 'duplicate',
  duplicate_order: 'duplicate',
};

export type EBillsConfig = {
  username: string;
  password: string;
  baseUrl?: string;
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so token expiry is exercisable without waiting days. */
  now?: () => number;
};

/**
 * eBills adapter.
 *
 * Three properties of their API shape this class, and none are optional:
 *
 * 1. **Only one token is ever valid.** Their docs are explicit: issuing a new
 *    token invalidates every earlier one. Two processes authenticating against
 *    the same account therefore knock each other offline, so exactly one cached
 *    token is held here and concurrent callers await the same refresh.
 *
 * 2. **The success webhook cannot be trusted.** Their documentation notes the
 *    `completed-api` notification fires "only when triggered manually by an
 *    administrator" — only the *refunded* hook is automatic. Success has to be
 *    established by requery, so {@link status} is the source of truth and the
 *    webhook is at best a hint.
 *
 * 3. **The wallet serialises.** Concurrent orders return `429 wallet_busy`,
 *    because every order debits one shared float. Requests are queued here
 *    rather than left to collide.
 */
export class EBillsProvider implements BillsProvider {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  private token: string | null = null;
  private tokenIssuedAt = 0;
  /** In-flight refresh, shared so a burst of callers triggers exactly one login. */
  private refreshing: Promise<string> | null = null;
  /** Tail of the request queue. See property 3 above. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: EBillsConfig) {
    this.base = (config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.doFetch = config.fetchImpl ?? globalThis.fetch;
    this.now = config.now ?? Date.now;
  }

  async balance(): Promise<number> {
    const body = await this.authed<{ data: { balance: number | string } }>(
      'GET',
      '/api/v2/balance',
    );
    return Number(body.data.balance);
  }

  async buyAirtime(order: AirtimeOrder): Promise<OrderResult> {
    if (order.reference.length > 50) {
      throw new BillsError('reference exceeds the 50-character limit', 'invalid_request');
    }
    const body = await this.authed<{ data: Record<string, unknown> }>('POST', '/api/v2/airtime', {
      request_id: order.reference,
      phone: order.phone,
      service_id: order.network,
      amount: order.amountNaira,
    });
    return this.toResult(order.reference, body.data);
  }

  async status(reference: string): Promise<OrderResult> {
    const body = await this.authed<{ data: Record<string, unknown> }>('POST', '/api/v2/requery', {
      request_id: reference,
    });
    return this.toResult(reference, body.data);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private toResult(reference: string, data: Record<string, unknown>): OrderResult {
    const status = String(data.status ?? '');
    return {
      reference,
      // An unrecognised status is treated as pending on purpose: the safe
      // reading of "I do not know what this means" is "the money may still be
      // moving", which keeps us requerying instead of refunding prematurely.
      state: STATE_BY_STATUS[status] ?? 'pending',
      providerOrderId: data.order_id != null ? String(data.order_id) : undefined,
      amountNaira: data.amount != null ? Number(data.amount) : undefined,
      chargedNaira: data.amount_charged != null ? Number(data.amount_charged) : undefined,
      balanceAfterNaira: data.final_balance != null ? Number(data.final_balance) : undefined,
      message: typeof data.message === 'string' ? data.message : undefined,
    };
  }

  /** Serialises every call, and retries exactly once if the token was stale. */
  private authed<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    const run = this.queue.then(
      () => this.send<T>(method, path, payload, false),
      () => this.send<T>(method, path, payload, false),
    );
    // Keep the chain alive whatever this call does, or one rejection would
    // wedge every request behind it.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    isRetry: boolean,
  ): Promise<T> {
    const token = await this.accessToken();
    const res = await this.doFetch(this.base + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return body as T;

    const code = String(body.code ?? '');
    const kind = ERROR_BY_CODE[code] ?? (res.status === 400 ? 'invalid_request' : 'unknown');

    // A rejected token is worth one silent retry. `rest_forbidden` is not — it
    // means the role or the IP allow-list, and re-authenticating would just
    // burn the token another process may be relying on.
    if (kind === 'auth_failed' && !isRetry) {
      this.token = null;
      return this.send<T>(method, path, payload, true);
    }

    throw new BillsError(
      String(body.message ?? 'eBills ' + res.status).replace(/<[^>]*>/g, ''),
      kind,
      kind === 'busy',
    );
  }

  private accessToken(): Promise<string> {
    if (this.token && this.now() - this.tokenIssuedAt < TOKEN_TTL_MS) {
      return Promise.resolve(this.token);
    }
    // Collapse concurrent refreshes. Two logins would leave one of them holding
    // a token the other had already invalidated.
    this.refreshing ??= this.login().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async login(): Promise<string> {
    const res = await this.doFetch(this.base + '/jwt-auth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.config.username,
        password: this.config.password,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (!res.ok || typeof body.token !== 'string') {
      throw new BillsError(
        String(body.message ?? 'eBills login failed').replace(/<[^>]*>/g, ''),
        ERROR_BY_CODE[String(body.code ?? '')] ?? 'auth_failed',
      );
    }

    this.token = body.token;
    this.tokenIssuedAt = this.now();
    return this.token;
  }
}
