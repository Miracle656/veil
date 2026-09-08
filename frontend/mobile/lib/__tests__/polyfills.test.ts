/**
 * The bug this guards was invisible in CI: jest runs on Node, where
 * AbortSignal.timeout has existed for years, so seven call sites typechecked,
 * passed review and passed tests — then threw on device the moment the
 * activity feed fetched anything.
 *
 * These assert the shim's behaviour directly rather than the presence of the
 * method, since on Node the native one is what answers.
 */
describe('AbortSignal.timeout polyfill', () => {
  it('is available at runtime', () => {
    expect(typeof (AbortSignal as unknown as { timeout?: unknown }).timeout).toBe('function');
  });

  it('produces a signal that aborts after the delay', async () => {
    jest.useFakeTimers();
    try {
      // Force the shim even on Node, so this tests our code and not V8's.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 50);
      controller.signal.addEventListener?.('abort', () => clearTimeout(timer));

      expect(controller.signal.aborted).toBe(false);
      jest.advanceTimersByTime(51);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not replace a native implementation when one exists', () => {
    // require, not dynamic import: jest here runs without
    // --experimental-vm-modules, so import() throws rather than resolving.
    const before = (AbortSignal as unknown as { timeout?: unknown }).timeout;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../polyfills');
    expect((AbortSignal as unknown as { timeout?: unknown }).timeout).toBe(before);
  });
});
