/**
 * Per-project rate limiter enforcing Expo's 600 notifications/sec limit (#1275).
 */

export interface RateLimiterOptions {
  /** Maximum notifications per window (default: 600). */
  limit?: number;
  /** Window duration in milliseconds (default: 1,000 ms). */
  windowMs?: number;
  /** Injectable time provider for deterministic testing. */
  now?: () => number;
  /** Injectable sleep provider for deterministic testing. */
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Timestamps of sent notifications keyed by projectId. */
  private readonly projectWindows = new Map<string, number[]>();

  /** Recorded sleep durations for inspection and testing. */
  public readonly recordedDelays: number[] = [];

  constructor(options: RateLimiterOptions = {}) {
    this.limit = options.limit ?? 600;
    this.windowMs = options.windowMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Acquire capacity for `count` notifications under `projectId`.
   * Sleeps until capacity is available if limit would be exceeded.
   * Returns total milliseconds slept.
   */
  async acquire(projectId: string = 'default', count: number = 1): Promise<number> {
    if (count <= 0) return 0;
    if (count > this.limit) {
      throw new Error(
        `Requested batch size ${count} exceeds absolute project rate limit of ${this.limit}/sec`,
      );
    }

    let totalSleptMs = 0;

    let timestamps = this.projectWindows.get(projectId);
    if (!timestamps) {
      timestamps = [];
      this.projectWindows.set(projectId, timestamps);
    }

    while (true) {
      const currentTime = this.now();
      const cutoff = currentTime - this.windowMs;

      // Prune timestamps older than window
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }

      // Check if adding `count` exceeds limit
      if (timestamps.length + count <= this.limit) {
        for (let i = 0; i < count; i++) {
          timestamps.push(currentTime);
        }
        break;
      }

      // Need to wait until the oldest entry expires
      const oldest = timestamps[0];
      const waitMs = Math.max(1, oldest + this.windowMs - currentTime);

      this.recordedDelays.push(waitMs);
      totalSleptMs += waitMs;

      await this.sleep(waitMs);
    }

    return totalSleptMs;
  }

  /** Clear rate limiter state. */
  reset(): void {
    this.projectWindows.clear();
    this.recordedDelays.length = 0;
  }
}
