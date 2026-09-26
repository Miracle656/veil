import {
  areRatesLive,
  getCurrency,
  getRate,
  setCurrency,
  subscribeToCurrency,
} from '../../lib/currency';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn().mockResolvedValue(null),
  setItem: jest.fn().mockResolvedValue(undefined),
  removeItem: jest.fn().mockResolvedValue(undefined),
}));

/**
 * The exact snapshot `useCurrency` subscribes to.
 *
 * Duplicated here on purpose. The repo has no React renderer in its test deps,
 * so the hook cannot be mounted; what *can* be pinned is the contract the hook
 * now depends on — that this string changes when the currency does, and that
 * everything the hook returns is derivable from it.
 *
 * That contract is the fix. Switching currency in Settings previously required
 * an app relaunch: `useSyncExternalStore` re-rendered the component correctly,
 * but the hook then called `getCurrency()` separately — a bare module read the
 * React Compiler (enabled in app.config.ts) may treat as invariant and cache —
 * so the render painted the stale value. The hook now derives from this
 * snapshot instead.
 */
function snapshot(): string {
  return `${getCurrency()}:${getRate(getCurrency())}:${areRatesLive() ? 1 : 0}`;
}

describe('currency store — the snapshot useCurrency subscribes to', () => {
  it('notifies subscribers when the currency changes', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToCurrency(listener);

    await setCurrency('USD');
    listener.mockClear();
    await setCurrency('NGN');

    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('produces a different snapshot after a switch, so subscribers re-render', async () => {
    await setCurrency('USD');
    const before = snapshot();

    await setCurrency('NGN');
    const after = snapshot();

    expect(after).not.toBe(before);
    expect(after.startsWith('NGN:')).toBe(true);
  });

  it('carries the currency, its rate and liveness — everything the hook returns', async () => {
    await setCurrency('NGN');
    const [code, rate, live] = snapshot().split(':');

    expect(code).toBe('NGN');
    expect(Number(rate)).toBeGreaterThan(0);
    expect(['0', '1']).toContain(live);
  });

  it('stops notifying after unsubscribe', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToCurrency(listener);
    unsubscribe();

    await setCurrency('KES');

    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects an unknown currency rather than silently keeping the old one', async () => {
    await expect(setCurrency('XXX' as never)).rejects.toThrow(/Unknown currency/);
  });
});
