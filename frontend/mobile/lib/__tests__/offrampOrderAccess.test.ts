/**
 * Reading a cash-out back now needs a bearer token (wraith #216).
 *
 * The risk these cover is specific: the credential is shown once, at creation,
 * and the backend keeps only its SHA-256. If the client drops it, the order is
 * unreadable for good — while real money is already on its way to a bank. So
 * these pin that it is stored, that it is sent, that the old storage format
 * still reads, and that a refusal is reported as its own thing rather than as a
 * generic failure the screen would retry forever.
 */

const store: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => store[k] ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    store[k] = v;
  }),
  removeItem: jest.fn(async (k: string) => {
    delete store[k];
  }),
}));

const ORDER_ID = 'ofr_3kQpV8nZr2LmXy7wTb4Dse';
const TOKEN = 'oft_9fK2mQ7xW4zRb8NvYc3HdJ5sLpTg1AeUo6iXr0MnB2w';
/** The key the module owns. Hard-coded because the module is required per-test. */
const ACTIVE_ORDER_KEY = 'veil_offramp_active_order';

/** A fetch that answers once, with a status and a JSON body. */
function answering(status: number, body: unknown): jest.Mock {
  return jest.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

describe('offramp order access', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    for (const k of Object.keys(store)) delete store[k];
    // Read at module load, so it has to be set before the require() below.
    process.env.EXPO_PUBLIC_WRAITH_URL = 'https://wraith.test';
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('remembering an order', () => {
    it('keeps the token beside the id', async () => {
      const { rememberActiveOrder, activeOrder } = require('../offramp');
      await rememberActiveOrder(ORDER_ID, TOKEN);
      await expect(activeOrder()).resolves.toEqual({ id: ORDER_ID, token: TOKEN });
    });

    it('reads back an order stored before tokens existed', async () => {
      // An app update does not clear this key. Someone mid-cash-out when they
      // updated has a bare id sitting here, and dropping it would mean the
      // screen forgetting a cash-out money is already on its way to.
      store[ACTIVE_ORDER_KEY] = ORDER_ID;
      const { activeOrder } = require('../offramp');
      await expect(activeOrder()).resolves.toEqual({ id: ORDER_ID });
    });

    it('stores an order the backend issued no token for', async () => {
      // An older backend deploy. The id is still worth keeping.
      const { rememberActiveOrder, activeOrder } = require('../offramp');
      await rememberActiveOrder(ORDER_ID);
      await expect(activeOrder()).resolves.toEqual({ id: ORDER_ID });
    });

    it('has nothing to report when nothing is in flight', async () => {
      const { activeOrder } = require('../offramp');
      await expect(activeOrder()).resolves.toBeNull();
    });
  });

  describe('reading an order', () => {
    it('sends the token as a bearer credential', async () => {
      const fetchMock = answering(200, { id: ORDER_ID, status: 'settled' });
      global.fetch = fetchMock as unknown as typeof fetch;

      const { getOrderStatus } = require('../offramp');
      await getOrderStatus(ORDER_ID, TOKEN);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('sends no Authorization header when there is no token', async () => {
      const fetchMock = answering(200, { id: ORDER_ID, status: 'settled' });
      global.fetch = fetchMock as unknown as typeof fetch;

      const { getOrderStatus } = require('../offramp');
      await getOrderStatus(ORDER_ID);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    });

    // 401 is "no usable token"; 404 is "unknown id, or a token that is not this
    // order's" — the backend makes those two indistinguishable on purpose, so a
    // stranger cannot probe for real ids. Both mean the same thing to us.
    it.each([401, 404])('reports %i as an order this device cannot read', async (status) => {
      global.fetch = answering(status, { error: 'Not found' }) as unknown as typeof fetch;

      const { getOrderStatus, OfframpOrderUnreadable } = require('../offramp');
      await expect(getOrderStatus(ORDER_ID, TOKEN)).rejects.toBeInstanceOf(OfframpOrderUnreadable);
    });

    it('leaves other failures as ordinary errors the screen can retry', async () => {
      // A bad gateway is transient. Confusing it with a credential we will
      // never have would stop the polling that is about to start working again.
      global.fetch = answering(502, { error: 'Bad gateway' }) as unknown as typeof fetch;

      const { getOrderStatus, OfframpOrderUnreadable } = require('../offramp');
      const err = await getOrderStatus(ORDER_ID, TOKEN).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(OfframpOrderUnreadable);
    });

    it('does not turn a 404 on a write into a lost credential', async () => {
      // Only reads carry a token, so a 404 from a POST is an ordinary failure.
      global.fetch = answering(404, { error: 'No such route' }) as unknown as typeof fetch;

      const { verifyBankAccount, OfframpOrderUnreadable } = require('../offramp');
      const err = await verifyBankAccount('058', '0123456789').catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(OfframpOrderUnreadable);
    });
  });
});
