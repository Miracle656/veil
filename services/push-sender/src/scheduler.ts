/**
 * Cancellable scheduled receipt poller for Expo Push API (#1275).
 * Mirrors patterns from services/spp-bootnode/src/indexer.ts.
 */

import type { ExpoClient } from './expoClient.js';
import { redactUrlsInText } from './redact.js';
import type { ReceiptPollReport } from './types.js';

export interface SchedulerStatus {
  running: boolean;
  pollIntervalMs: number;
  lastPollAt: number | null;
  lastError: string | null;
  pollCount: number;
  lastReport: ReceiptPollReport | null;
}

export interface SchedulerOptions {
  intervalMs?: number;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export class ReceiptScheduler {
  private readonly client: ExpoClient;
  private readonly intervalMs: number;
  private readonly logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };

  private running: boolean = false;
  private stopped: boolean = false;
  private stopPromise: Promise<void> | null = null;
  private stopResolve: (() => void) | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private pollCount: number = 0;
  private lastReport: ReceiptPollReport | null = null;

  constructor(client: ExpoClient, options: SchedulerOptions = {}) {
    this.client = client;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.logger = options.logger ?? {
      info: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
    };
  }

  getStatus(): SchedulerStatus {
    return {
      running: this.running,
      pollIntervalMs: this.intervalMs,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      pollCount: this.pollCount,
      lastReport: this.lastReport,
    };
  }

  /** Run a single receipt polling cycle. */
  async runOnce(): Promise<ReceiptPollReport> {
    try {
      const report = await this.client.pollReceipts();
      this.lastPollAt = Date.now();
      this.lastError = null;
      this.pollCount++;
      this.lastReport = report;

      if (report.polledTickets > 0 || report.expiredTickets > 0) {
        this.logger.info(
          `[ReceiptScheduler] Poll complete: ${report.resolvedTickets} resolved, ` +
            `${report.prunedTokens.length} pruned, ${report.expiredTickets} expired, ` +
            `${report.pendingTickets} pending.`,
        );
      }

      return report;
    } catch (err) {
      const msg = redactUrlsInText((err as Error).message);
      this.lastError = msg;
      this.logger.error(`[ReceiptScheduler] Poll error: ${msg}`);
      throw err;
    }
  }

  /** Start the background polling loop. */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.stopped = false;
    this.stopPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });

    const loop = async () => {
      while (!this.stopped) {
        try {
          await this.runOnce();
        } catch {
          // Error already logged and stored in this.lastError
        }

        if (this.stopped) break;

        // Sleep for intervalMs, waking early if stop() is called
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.stopPromise?.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      this.running = false;
      this.stopResolve?.();
    };

    void loop();
  }

  /** Stop the polling loop and await completion of the in-flight cycle. */
  async stop(): Promise<void> {
    if (!this.running || this.stopped) {
      return;
    }
    this.stopped = true;
    await this.stopPromise;
  }
}
