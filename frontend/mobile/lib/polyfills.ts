/**
 * Runtime gaps in Hermes that the app's code assumes are present.
 *
 * Imported for its side effects, first thing in app/_layout.tsx, so it runs
 * before any screen can call the APIs it fills in.
 */

/**
 * `AbortSignal.timeout(ms)` — standard since 2022, absent in Hermes.
 *
 * Without it every `fetch(url, { signal: AbortSignal.timeout(...) })` throws
 * "AbortSignal.timeout is not a function" the moment it runs. It failed loudly
 * rather than quietly, but only on the paths that reach the network — the
 * activity feed and the whole SEP-24 deposit/withdraw flow, seven call sites
 * that each looked correct in review and in tests, because jest runs on Node
 * where the method exists.
 *
 * Polyfilled once here rather than replaced at each call site, so code written
 * against the standard keeps working and a future eighth use cannot
 * reintroduce the crash.
 */
if (typeof AbortSignal !== 'undefined') {
  const AS = AbortSignal as unknown as {
    timeout?: (ms: number) => AbortSignal;
  };
  if (typeof AS.timeout !== 'function') {
    AS.timeout = (ms: number): AbortSignal => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      // Clear on abort so a request that finishes early does not hold a timer
      // for the rest of the window. Nothing can tell us the fetch resolved, so
      // this is the only hook available.
      controller.signal.addEventListener?.('abort', () => clearTimeout(timer));
      return controller.signal;
    };
  }
}

export {};
