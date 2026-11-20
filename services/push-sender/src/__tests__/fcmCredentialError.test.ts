import { describe, expect, it, vi } from 'vitest';
import { ExpoClient } from '../expoClient.js';
import { InMemoryPushStore } from '../store.js';

describe('Silent FCM credential failure surfaced', () => {
  it('captures InvalidCredentials from getReceipts in deliveryErrors and logs a redacted warning', async () => {
    const store = new InMemoryPushStore();
    const token = 'ExponentPushToken[fcm-token-target]';
    const now = 5000000;

    await store.saveTickets([
      {
        ticketId: 't-fcm-error',
        token,
        sentAt: now - 20 * 60 * 1000,
        readyAt: now - 1000,
        expiresAt: now + 20 * 60 * 1000,
        attempts: 0,
        status: 'pending',
      },
    ]);

    // Send was "ok", but Expo receipt says InvalidCredentials (e.g. invalid FCM server key / service account)
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: {
          't-fcm-error': {
            status: 'error',
            message: 'Invalid FCM v1 credentials on Android push channel',
            details: { error: 'InvalidCredentials' },
          },
        },
      }),
    }));

    const warnMock = vi.fn();
    const client = new ExpoClient({
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
      logger: {
        info: vi.fn(),
        warn: warnMock,
        error: vi.fn(),
      },
    });

    const report = await client.pollReceipts();

    // 1. Surfaced in deliveryErrors
    expect(report.deliveryErrors).toHaveLength(1);
    expect(report.deliveryErrors[0].ticketId).toBe('t-fcm-error');
    expect(report.deliveryErrors[0].error).toBe('InvalidCredentials');
    expect(report.deliveryErrors[0].token).toBe(token);

    // 2. Ticket is resolved (not left in pending limbo)
    expect(report.resolvedTickets).toBe(1);
    expect(report.pendingTickets).toBe(0);

    // 3. Redacted warning log emitted
    expect(warnMock).toHaveBeenCalled();
    const loggedMsg = warnMock.mock.calls[0][0];
    expect(loggedMsg).toContain('InvalidCredentials');
    // Token is redacted in log
    expect(loggedMsg).toContain('ExponentPushToken[REDACTED]');
  });
});
