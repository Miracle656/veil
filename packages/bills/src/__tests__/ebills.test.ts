import { EBillsProvider } from '../ebills.js';
import { MockBillsProvider } from '../mock.js';
import { newReference } from '../reference.js';
import { BillsError } from '../types.js';

/** Builds a fetch stub that answers from a scripted queue, recording calls. */
function stubFetch(script: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: unknown; auth?: string }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const next = script.shift();
    if (!next) throw new Error('unexpected extra fetch to ' + String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization,
    });
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const TOKEN = { status: 200, body: { token: 'tok-1', user_nicename: 'veil' } };

function provider(script: Array<{ status: number; body: unknown }>, now = () => 0) {
  const { impl, calls } = stubFetch(script);
  return {
    calls,
    p: new EBillsProvider({
      username: 'u',
      password: 'p',
      fetchImpl: impl,
      now,
    }),
  };
}

describe('EBillsProvider authentication', () => {
  it('logs in once and reuses the token across calls', async () => {
    const { p, calls } = provider([
      TOKEN,
      { status: 200, body: { data: { balance: '5000.00', currency: 'NGN' } } },
      { status: 200, body: { data: { balance: '4900.00', currency: 'NGN' } } },
    ]);

    await p.balance();
    await p.balance();

    // One login, not two — issuing a second token would invalidate the first.
    const logins = calls.filter((c) => c.url.includes('/jwt-auth/'));
    expect(logins).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('/balance'))).toHaveLength(2);
  });

  it('collapses concurrent cold-start calls into a single login', async () => {
    const { p, calls } = provider([
      TOKEN,
      { status: 200, body: { data: { balance: 1 } } },
      { status: 200, body: { data: { balance: 1 } } },
      { status: 200, body: { data: { balance: 1 } } },
    ]);

    await Promise.all([p.balance(), p.balance(), p.balance()]);

    expect(calls.filter((c) => c.url.includes('/jwt-auth/'))).toHaveLength(1);
  });

  it('re-authenticates once when the token is rejected', async () => {
    const { p, calls } = provider([
      TOKEN,
      { status: 403, body: { code: 'jwt_auth_invalid_token', message: 'bad token' } },
      { status: 200, body: { token: 'tok-2' } },
      { status: 200, body: { data: { balance: 42 } } },
    ]);

    await expect(p.balance()).resolves.toBe(42);
    expect(calls.filter((c) => c.url.includes('/jwt-auth/'))).toHaveLength(2);
    expect(calls.at(-1)?.auth).toBe('Bearer tok-2');
  });

  it('does NOT re-authenticate on rest_forbidden', async () => {
    // That status means the missing reseller role or an IP allow-list, and
    // re-logging in would burn a token another process may be using.
    const { p, calls } = provider([
      TOKEN,
      { status: 403, body: { code: 'rest_forbidden', message: 'nope' } },
    ]);

    await expect(p.balance()).rejects.toMatchObject({ code: 'forbidden' });
    expect(calls.filter((c) => c.url.includes('/jwt-auth/'))).toHaveLength(1);
  });
});

describe('EBillsProvider orders', () => {
  it('sends our reference as request_id', async () => {
    const { p, calls } = provider([
      TOKEN,
      {
        status: 200,
        body: {
          data: {
            order_id: 12345,
            status: 'processing-api',
            amount: 100,
            amount_charged: '97.50',
            final_balance: '4902.50',
          },
        },
      },
    ]);

    const res = await p.buyAirtime({
      reference: 'veil_abc',
      network: 'mtn',
      phone: '08012345678',
      amountNaira: 100,
    });

    expect(calls.at(-1)?.body).toMatchObject({
      request_id: 'veil_abc',
      service_id: 'mtn',
      amount: 100,
    });
    // Dispatch accepted is not delivery.
    expect(res.state).toBe('pending');
    expect(res.chargedNaira).toBe(97.5);
  });

  it('maps every documented status onto a state', async () => {
    const cases: Array<[string, string]> = [
      ['completed-api', 'delivered'],
      ['processing-api', 'pending'],
      ['queued-api', 'pending'],
      ['initiated-api', 'pending'],
      ['on-hold', 'pending'],
      ['refunded', 'refunded'],
      ['cancelled', 'failed'],
      ['failed', 'failed'],
      ['something-they-added-later', 'pending'],
    ];

    for (const [status, expected] of cases) {
      const { p } = provider([TOKEN, { status: 200, body: { data: { status } } }]);
      await expect(p.status('veil_x')).resolves.toMatchObject({ state: expected });
    }
  });

  it('treats an unknown status as pending rather than failed', async () => {
    // Refunding a user because we did not recognise a word would be the
    // expensive mistake; requerying costs one request.
    const { p } = provider([TOKEN, { status: 200, body: { data: { status: '' } } }]);
    await expect(p.status('veil_x')).resolves.toMatchObject({ state: 'pending' });
  });

  it('surfaces a duplicate reference as its own code, not a generic failure', async () => {
    const { p } = provider([
      TOKEN,
      { status: 409, body: { code: 'duplicate_request_id', message: 'exists' } },
    ]);

    await expect(
      p.buyAirtime({ reference: 'veil_dup', network: 'mtn', phone: '080', amountNaira: 50 }),
    ).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('marks wallet_busy retryable and insufficient_funds not', async () => {
    const busy = provider([TOKEN, { status: 429, body: { code: 'wallet_busy' } }]);
    await expect(busy.p.balance()).rejects.toMatchObject({ code: 'busy', retryable: true });

    const broke = provider([TOKEN, { status: 402, body: { code: 'insufficient_funds' } }]);
    await expect(broke.p.balance()).rejects.toMatchObject({
      code: 'insufficient_float',
      retryable: false,
    });
  });

  it('rejects an over-long reference before dispatching it', async () => {
    // Must fail locally: failing at the provider risks the order having landed.
    const { p, calls } = provider([]);
    await expect(
      p.buyAirtime({ reference: 'v'.repeat(51), network: 'mtn', phone: '080', amountNaira: 50 }),
    ).rejects.toBeInstanceOf(BillsError);
    expect(calls).toHaveLength(0);
  });

  it('keeps serving requests after one fails', async () => {
    const { p } = provider([
      TOKEN,
      { status: 429, body: { code: 'wallet_busy' } },
      { status: 200, body: { data: { balance: 7 } } },
    ]);

    await expect(p.balance()).rejects.toMatchObject({ code: 'busy' });
    // A rejection must not wedge the queue behind it.
    await expect(p.balance()).resolves.toBe(7);
  });
});

describe('newReference', () => {
  it('stays inside the 50-character limit', () => {
    expect(newReference().length).toBeLessThanOrEqual(50);
    expect(newReference('veil-airtime-testnet').length).toBeLessThanOrEqual(50);
  });

  it('throws for a prefix that would overflow, rather than truncating', () => {
    expect(() => newReference('x'.repeat(60))).toThrow();
  });

  it('does not collide within the same millisecond', () => {
    const refs = new Set(Array.from({ length: 500 }, () => newReference()));
    expect(refs.size).toBe(500);
  });
});

describe('MockBillsProvider', () => {
  it('settles only after a requery, never on dispatch', async () => {
    const m = new MockBillsProvider({ pendingPolls: 1 });
    const ref = newReference();

    expect((await m.buyAirtime({ reference: ref, network: 'mtn', phone: '080', amountNaira: 100 })).state).toBe('pending');
    expect((await m.status(ref)).state).toBe('pending');
    expect((await m.status(ref)).state).toBe('delivered');
  });

  it('refuses a reused reference instead of vending twice', async () => {
    const m = new MockBillsProvider();
    const order = { reference: 'veil_same', network: 'mtn' as const, phone: '080', amountNaira: 100 };
    await m.buyAirtime(order);
    await expect(m.buyAirtime(order)).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('debits below face value by the discount, and restores it on refund', async () => {
    const m = new MockBillsProvider({ balanceNaira: 1000, discount: 0.03, settleAs: 'refunded', pendingPolls: 0 });
    const ref = newReference();

    await m.buyAirtime({ reference: ref, network: 'mtn', phone: '080', amountNaira: 100 });
    expect(await m.balance()).toBe(903); // charged 97, not 100 — the 3% is the margin

    await m.status(ref);
    expect(await m.balance()).toBe(1000);
  });

  it('refuses an order the float cannot cover', async () => {
    const m = new MockBillsProvider({ balanceNaira: 50 });
    await expect(
      m.buyAirtime({ reference: newReference(), network: 'mtn', phone: '080', amountNaira: 500 }),
    ).rejects.toMatchObject({ code: 'insufficient_float' });
  });
});
