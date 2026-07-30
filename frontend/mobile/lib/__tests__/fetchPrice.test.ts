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

  it('returns null on a non-OK status (e.g. 402 payment required)', async () => {
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
