/**
 * Cable TV and betting lookup clients.
 *
 * These call `POST /ngn/bills/lookup/{cabletv,betting}`, which wraith does not
 * implement yet — it has `GET /ngn/bills/data-bundles`, `POST /ngn/bills` and
 * `GET /ngn/bills/:orderId`, and `src/linq/bills.ts` has no customer-validation
 * call to build the route from. Both screens are gated to 'soon' on mobile and
 * web until it exists.
 *
 * So what is worth pinning now is the wire contract: the path each client
 * posts to and the body it sends. That is what the route will have to match
 * the day somebody writes it, and getting it wrong is a 404 on a money screen.
 *
 * The original version of this file referenced `call`, `lookupCableTv` and
 * `lookupBetting` as free variables — never imported, never mocked — so the
 * later blocks could not have run. Rewritten against a mocked `fetch`, which
 * is how the module actually talks out.
 */

// `onramp.ts` reads its base URL once at module load and refuses to call out
// at all when it is unset ("No backend configured for naira rails."), so the
// env has to be set before the module is first required — which a top-level
// import is too late for.
process.env['EXPO_PUBLIC_WRAITH_URL'] = 'https://wraith.test';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isBillCategoryAvailable, lookupBetting, lookupCableTv } = require('../onramp');

const originalFetch = global.fetch;

/** Capture what the client sent, and reply with `body`. */
function mockFetch(body: unknown, ok = true, status = 200) {
  const spy = jest.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response);
  global.fetch = spy as unknown as typeof fetch;
  return spy;
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('the lookup clients exist', () => {
  it('exports a function for each lookup the screens call', () => {
    expect(typeof lookupCableTv).toBe('function');
    expect(typeof lookupBetting).toBe('function');
    expect(typeof isBillCategoryAvailable).toBe('function');
  });
});

describe('cable TV lookup', () => {
  const found = {
    customerName: 'John Doe',
    currentPackage: 'DSTV Compact',
    dueDate: '2026-11-15',
    availablePackages: [
      { id: 'pkg1', name: 'DSTV Compact', price: 10500 },
      { id: 'pkg2', name: 'DSTV Compact Plus', price: 16500 },
    ],
  };

  it('posts the smartcard to the agreed path and returns what came back', async () => {
    const spy = mockFetch(found);

    await expect(
      lookupCableTv({ provider: 'dstv', smartcardNumber: '1234567890' }),
    ).resolves.toEqual(found);

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('/ngn/bills/lookup/cabletv');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      provider: 'dstv',
      smartcardNumber: '1234567890',
    });
  });

  it('rejects rather than returning a half-answer when the lookup fails', async () => {
    // The caller shows the customer's name before they spend. A failed lookup
    // that resolved would put an empty name in front of a payment.
    mockFetch({ error: 'Smartcard not found', code: 'not_found' }, false, 404);
    await expect(
      lookupCableTv({ provider: 'dstv', smartcardNumber: '0000000000' }),
    ).rejects.toBeDefined();
  });
});

describe('betting lookup', () => {
  const found = { accountName: 'Jane Doe', accountStatus: 'active', balance: 2500 };

  it('posts the account id to the agreed path and returns what came back', async () => {
    const spy = mockFetch(found);

    await expect(
      lookupBetting({ provider: 'bet9ja', accountId: 'ACC123' }),
    ).resolves.toEqual(found);

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('/ngn/bills/lookup/betting');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ provider: 'bet9ja', accountId: 'ACC123' });
  });

  it('rejects when the account cannot be verified', async () => {
    mockFetch({ error: 'Account not found', code: 'not_found' }, false, 404);
    await expect(
      lookupBetting({ provider: 'bet9ja', accountId: 'nope' }),
    ).rejects.toBeDefined();
  });
});
