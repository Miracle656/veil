/**
 * Which endpoint answers which question.
 *
 * wraith is mid-rollout on making `coin` required on the cash-out rate call.
 * During that window a build that asks `/offramp/rate` "is cash-out up?" gets a
 * 400 the first time it prices the wrong asset, reads it as the service being
 * down, and hides the tile — permanently, for an installed APK that never
 * updates. The fix is to stop borrowing a pricing endpoint for the health
 * check, and to refuse a quote that is for a different asset than the one the
 * screen is about to divide naira by.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

const BASE = 'https://backend.example';

function response(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A fetch that records the paths it was sent and answers with `payload`. */
function recordRequests(payload: unknown, status = 200): string[] {
  const paths: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string) => {
    paths.push(String(url).slice(BASE.length));
    return response(status, payload);
  });
  return paths;
}

describe('the cash-out gate and the coin it prices', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.EXPO_PUBLIC_WRAITH_URL = BASE;
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_WRAITH_URL;
  });

  it('asks availability of the availability endpoint, not the price endpoint', async () => {
    const paths = recordRequests({ available: true });

    const { isOfframpAvailable } = (require('../offramp') as typeof import('../offramp'));
    await expect(isOfframpAvailable()).resolves.toBe(true);

    // A single call, and it is not /offramp/rate. Linq's rate allowance is
    // shared across every user, so a launch that only wants to know whether to
    // show a tile must not spend part of it.
    expect(paths).toEqual(['/offramp/availability']);
  });

  it('does not read an empty 200 as available', async () => {
    // An edge proxy or an older backend answers something this client cannot
    // read. Offering a flow that fails on the first tap is worse than a tile
    // that is briefly missing.
    recordRequests({});

    const { isOfframpAvailable } = (require('../offramp') as typeof import('../offramp'));
    await expect(isOfframpAvailable()).resolves.toBe(false);
  });

  it('sends the coin the screen is cashing out', async () => {
    const paths = recordRequests({ coin: 'usdc', rate: 1352.65, indicative: true });

    const { getOfframpRate } = (require('../offramp') as typeof import('../offramp'));
    await expect(getOfframpRate('usdc')).resolves.toMatchObject({ rate: 1352.65 });

    expect(paths).toEqual(['/offramp/rate?coin=usdc']);
  });

  it('refuses a quote priced for a different asset', async () => {
    // The money half. `ngn / rate` is how the screen works out how much USDC to
    // send, so a USDC number answering to "xlm" asks for roughly five times too
    // much of the asset. Whatever the server says its price is, it has to say
    // which asset it is a price for.
    recordRequests({ coin: 'usdc', rate: 1352.65, indicative: true });

    const { getOfframpRate } = (require('../offramp') as typeof import('../offramp'));
    await expect(getOfframpRate('xlm')).rejects.toThrow(/different asset/);
  });

  // An older backend passed Linq's own `USDC` through, and this bundle has to
  // keep working against one it does not control.
  it('accepts the provider\'s spelling of the coin it asked for', async () => {
    recordRequests({ coin: 'USDC', rate: 1352.65, indicative: true });

    const { getOfframpRate } = (require('../offramp') as typeof import('../offramp'));
    await expect(getOfframpRate('usdc')).resolves.toMatchObject({ rate: 1352.65 });
  });

  it('refuses a rate it would have to divide by', async () => {
    recordRequests({ coin: 'usdc', rate: 0, indicative: true });

    const { getOfframpRate } = (require('../offramp') as typeof import('../offramp'));
    await expect(getOfframpRate('usdc')).rejects.toThrow(/unusable rate/);
  });
});
