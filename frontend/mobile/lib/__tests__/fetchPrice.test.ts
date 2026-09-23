/**
 * Tests for the Lens price-oracle client. The network call is best-effort, so
 * the contract under test is: USDC pins to 1 without a request, a good response
 * yields its price, and every failure mode (non-OK status, malformed body,
 * network error) collapses to `null` so the balance still renders. The fiat
 * helpers (`usdValue`, `formatUsd`) are pure and cover the price-unavailable
 * degradation path directly.
 */

import { fetchPrice, usdValue, formatUsd } from '../fetchPrice';

describe('fetchPrice', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  it('pins USDC to 1 without hitting the network', async () => {
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    await expect(fetchPrice('USDC', null)).resolves.toBe(1.0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns the quoted price on a successful response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ price: 0.12 }),
    }) as unknown as typeof fetch;
    await expect(fetchPrice('XLM', null)).resolves.toBe(0.12);
  });

  it('correctly maps non-native assets to CODE:ISSUER in the request URL', async () => {
    const spy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ price: 2.5 }),
    });
    global.fetch = spy as unknown as typeof fetch;
    await expect(fetchPrice('ABC', 'GABCD')).resolves.toBe(2.5);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('/price/ABC%3AGABCD/'),
      expect.any(Object)
    );
  });

  // These previously asserted a number came back, satisfied by a hardcoded
  // 0.11 XLM estimate. That estimate valued 5.35 XLM at $0.59 against a real
  // $0.99 while Lens was answering 401 — wrong by 40%, presented as fact. A
  // fiat figure is something a user acts on, so absent beats wrong, and any
  // baked-in rate is wrong within days. Null is now the contract.
  it('returns null on a non-OK status (401 no key, 402 gated, 404 unknown pair)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    await expect(fetchPrice('XLM', null)).resolves.toBeNull();
  });

  it('returns null when the price field is absent or non-numeric', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ price: 'nope' }),
    }) as unknown as typeof fetch;
    await expect(fetchPrice('XLM', null)).resolves.toBeNull();
  });

  it('returns null when the request throws (timeout / network error)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    await expect(fetchPrice('XLM', null)).resolves.toBeNull();
  });

  it('still prices USDC at 1, which is definitional rather than a guess', async () => {
    await expect(fetchPrice('USDC', null)).resolves.toBe(1.0);
  });
});

describe('usdValue', () => {
  it('multiplies balance by price', () => {
    expect(usdValue('10', 0.5)).toBe(5);
    expect(usdValue(4, 2)).toBe(8);
  });

  it('returns null when the price is unavailable', () => {
    expect(usdValue('10', null)).toBeNull();
  });

  it('returns null for a non-numeric balance', () => {
    expect(usdValue('abc', 1)).toBeNull();
  });
});

describe('formatUsd', () => {
  it('formats a value as USD to two decimals', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('shows an em dash when the value is unavailable', () => {
    expect(formatUsd(null)).toBe('—');
  });
});

/**
 * Lens is the preferred source but is regularly unavailable — API key off,
 * mainnet not ingested, service asleep. An unreachable oracle should cost
 * accuracy, not the number entirely, so the SDEX order book answers instead.
 *
 * Deliberately distinct from the hardcoded 0.11 that was removed: that was a
 * constant baked into the build and wrong by 40% within months. This is a live
 * mid between real bids and asks.
 */
describe('order book fallback', () => {
  const book = (bid: string, ask: string) => ({
    ok: true,
    text: async () => JSON.stringify({ bids: [{ price: bid }], asks: [{ price: ask }] }),
    json: async () => ({ bids: [{ price: bid }], asks: [{ price: ask }] }),
  });

  it('uses the SDEX mid when Lens cannot answer', async () => {
    global.fetch = jest
      .fn()
      // Lens: unauthorised, which is its current live behaviour without a key.
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce(book('0.1904', '0.1906')) as unknown as typeof fetch;

    await expect(fetchPrice('XLM', null)).resolves.toBeCloseTo(0.1905, 4);
  });

  it('refuses a one-sided book rather than quoting an untradeable price', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bids: [{ price: '0.19' }], asks: [] }),
      }) as unknown as typeof fetch;

    await expect(fetchPrice('XLM', null)).resolves.toBeNull();
  });

  it('returns null when both sources fail, rather than inventing one', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }) as unknown as typeof fetch;

    await expect(fetchPrice('XLM', null)).resolves.toBeNull();
  });
});
