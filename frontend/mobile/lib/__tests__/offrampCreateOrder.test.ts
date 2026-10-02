/**
 * Order creation's timeout behaviour.
 *
 * The bug these cover: users were shown "cash out is unavailable right now",
 * tapped again, and it worked — because the first request had created the order
 * and only our own 20s clock had given up. The retry is now automatic, and the
 * thing that makes it safe is that it repeats the *identical* body, so the
 * backend recognises the idempotency key and returns the order it already made.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

const params = {
  amountNGN: 10_000,
  bankAccount: '0123456789',
  bankCode: '058',
  bankName: 'GTBank',
  accountName: 'A Tester',
  refundAddress: 'GABC',
  walletAddress: 'CDEF',
  idempotencyKey: 'veil_1_abcdefgh',
};

const order = { id: 'ord_1', walletAddress: 'GDEPOSIT', status: 'initiated' };

/** A fetch that aborts the way the browser does when the signal fires. */
function abortingFetch(): jest.Mock {
  return jest.fn(
    (_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
      }),
  );
}

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

describe('createOrder', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    // Read at module load, so it has to be set before the require() below.
    process.env.EXPO_PUBLIC_WRAITH_URL = 'https://wraith.test';
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it('repeats the request once when the first attempt times out', async () => {
    const calls: string[] = [];
    let attempt = 0;
    global.fetch = jest.fn((_url: string, init: { signal?: AbortSignal; body?: string }) => {
      attempt += 1;
      calls.push(init.body ?? '');
      if (attempt === 1) {
        return new Promise((_r, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
          );
        });
      }
      return Promise.resolve(ok(order));
    }) as unknown as typeof fetch;

    const { createOrder } = require('../offramp');
    const promise = createOrder(params);
    await jest.advanceTimersByTimeAsync(61_000);

    await expect(promise).resolves.toMatchObject({ id: 'ord_1' });
    expect(attempt).toBe(2);
    // The identical body is what makes the repeat safe — a fresh idempotency
    // key here is how one order silently becomes two, both of them paid.
    expect(calls[0]).toBe(calls[1]);
    expect(JSON.parse(calls[1]).idempotencyKey).toBe('veil_1_abcdefgh');
  });

  it('gives the provider longer than the 20s used for reads', async () => {
    global.fetch = abortingFetch() as unknown as typeof fetch;

    const { createOrder, OfframpTimeout } = require('../offramp');
    const promise = createOrder(params).catch((e: Error) => e);

    // Still waiting well past the read timeout.
    await jest.advanceTimersByTimeAsync(25_000);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(100_000);
    expect(await promise).toBeInstanceOf(OfframpTimeout);
  });

  it('does not retry a 503 — that one really is unavailable', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: 'Offramp is not configured on this deployment' }),
    })) as unknown as typeof fetch;

    const { createOrder, OfframpUnavailable } = require('../offramp');
    const err = await createOrder(params).catch((e: Error) => e);

    expect(err).toBeInstanceOf(OfframpUnavailable);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a rejected request — a 400 is about the request', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'Unsupported bank code' }),
    })) as unknown as typeof fetch;

    const { createOrder } = require('../offramp');
    await expect(createOrder(params)).rejects.toThrow('Unsupported bank code');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
