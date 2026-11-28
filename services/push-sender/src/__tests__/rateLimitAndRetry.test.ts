import { describe, expect, it, vi } from 'vitest';
import { ExpoClient } from '../expoClient.js';
import { RateLimiter } from '../rateLimiter.js';
import { NonRetryableExpoError, retryWithBackoff } from '../retry.js';
import { InMemoryPushStore } from '../store.js';
import type { ExpoPushMessage } from '../types.js';

describe('Rate limiting & backoff actively exercised', () => {
  it('sending > 600 messages for one project invokes the 600/sec limiter and records non-zero sleep delays', async () => {
    let currentTime = 1000;
    const nowFn = () => currentTime;
    const recordedSleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      recordedSleeps.push(ms);
      currentTime += ms;
    };

    const rateLimiter = new RateLimiter({
      limit: 600,
      windowMs: 1000,
      now: nowFn,
      sleep: sleepFn,
    });

    const store = new InMemoryPushStore();

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as ExpoPushMessage[];
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: body.map((_, i) => ({ status: 'ok', id: `ticket-${i}` })),
        }),
      };
    });

    const client = new ExpoClient({
      store,
      rateLimiter,
      fetch: fetchMock as unknown as typeof fetch,
      now: nowFn,
      sleep: sleepFn,
    });

    // Send 700 messages for project 'alpha' -> 7 batches of 100
    const messages: ExpoPushMessage[] = Array.from({ length: 700 }, (_, i) => ({
      to: `ExponentPushToken[tok-${i}]`,
      title: 'Rate Limit Test',
      projectId: 'alpha',
    }));

    await client.sendNotifications(messages);

    // Batches 1..6 send 100 each = 600 total.
    // Batch 7 asks for 100 more, which exceeds 600 in the 1-second window.
    // RateLimiter must have called sleep!
    expect(recordedSleeps.length).toBeGreaterThan(0);
    expect(rateLimiter.recordedDelays.length).toBeGreaterThan(0);
    expect(rateLimiter.recordedDelays[0]).toBeGreaterThan(0);
  });

  it('retries HTTP 429 and 500/503 with exponential backoff and succeeds on later attempt', async () => {
    const sleepDelays: number[] = [];
    const sleepMock = vi.fn().mockImplementation(async (ms: number) => {
      sleepDelays.push(ms);
    });

    let attemptCount = 0;
    const operation = vi.fn().mockImplementation(async () => {
      attemptCount++;
      if (attemptCount === 1) {
        // First attempt: 503 Service Unavailable
        const res = new Response('Service Unavailable', { status: 503 });
        const { ExpoHttpError } = await import('../retry.js');
        throw new ExpoHttpError('Service Unavailable', 503);
      }
      if (attemptCount === 2) {
        // Second attempt: 429 Too Many Requests with Retry-After: 2 (seconds)
        const { ExpoHttpError } = await import('../retry.js');
        throw new ExpoHttpError('Rate Limited', 429, 2000);
      }
      // Third attempt: 200 Success
      return { success: true };
    });

    const result = await retryWithBackoff(operation, {
      baseDelayMs: 200,
      factor: 2,
      maxAttempts: 4,
      sleep: sleepMock,
    });

    expect(result).toEqual({ success: true });
    expect(attemptCount).toBe(3);
    expect(sleepDelays).toHaveLength(2);
    // First delay is baseDelay 200ms
    expect(sleepDelays[0]).toBe(200);
    // Second delay respects Retry-After (2000ms)
    expect(sleepDelays[1]).toBe(2000);
  });

  it('backs off and reschedules ticket when receipt returns MessageRateExceeded', async () => {
    const store = new InMemoryPushStore();
    const now = 1000000;

    await store.saveTickets([
      {
        ticketId: 't-rate',
        token: 'ExponentPushToken[rate-limited]',
        sentAt: now - 20 * 60 * 1000,
        readyAt: now - 1000,
        expiresAt: now + 20 * 60 * 1000,
        attempts: 1,
        status: 'pending',
      },
    ]);

    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: {
          't-rate': {
            status: 'error',
            message: 'Rate limit exceeded',
            details: { error: 'MessageRateExceeded' },
          },
        },
      }),
    }));

    const client = new ExpoClient({
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });

    const report = await client.pollReceipts();
    expect(report.rescheduledTickets).toBe(1);

    const pending = await store.listPendingTickets();
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(2);
    expect(pending[0].readyAt).toBeGreaterThan(now);
  });

  it('HTTP 400 and 401 fail immediately with NonRetryableExpoError after 1 attempt (zero retries)', async () => {
    let attempts = 0;
    const { ExpoHttpError } = await import('../retry.js');

    const op400 = async () => {
      attempts++;
      throw new ExpoHttpError('Bad Request - invalid field', 400);
    };

    await expect(retryWithBackoff(op400, { maxAttempts: 5 })).rejects.toThrow(
      NonRetryableExpoError,
    );
    expect(attempts).toBe(1);

    let attempts401 = 0;
    const op401 = async () => {
      attempts401++;
      throw new ExpoHttpError('Unauthorized', 401);
    };

    await expect(retryWithBackoff(op401, { maxAttempts: 5 })).rejects.toThrow(
      NonRetryableExpoError,
    );
    expect(attempts401).toBe(1);
  });
});
