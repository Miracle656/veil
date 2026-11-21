import { describe, expect, it, vi } from 'vitest';
import { ExpoClient } from '../expoClient.js';
import { InMemoryPushStore } from '../store.js';
import type { ExpoPushMessage } from '../types.js';

describe('Token pruning on DeviceNotRegistered', () => {
  it('prunes token immediately when send ticket returns DeviceNotRegistered error', async () => {
    const store = new InMemoryPushStore();
    const badToken = 'ExponentPushToken[unregistered-device-1]';
    const goodToken = 'ExponentPushToken[active-device-2]';

    await store.upsertToken({ token: badToken });
    await store.upsertToken({ token: goodToken });

    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: [
          {
            status: 'error',
            message: 'Device not registered',
            details: { error: 'DeviceNotRegistered' },
          },
          {
            status: 'ok',
            id: 'ticket-good',
          },
        ],
      }),
    }));

    const client = new ExpoClient({ store, fetch: fetchMock as unknown as typeof fetch });

    const messages: ExpoPushMessage[] = [
      { to: badToken, title: 'Alert 1' },
      { to: goodToken, title: 'Alert 2' },
    ];

    const report = await client.sendNotifications(messages);

    expect('prunedTokens' in report && report.prunedTokens).toContain(badToken);

    // Verify store has pruned the bad token but preserved good token
    const remainingTokens = (await store.listTokens()).map((t) => t.token);
    expect(remainingTokens).not.toContain(badToken);
    expect(remainingTokens).toContain(goodToken);
  });

  it('prunes token during receipt polling when receipt returns DeviceNotRegistered', async () => {
    const store = new InMemoryPushStore();
    const deadToken = 'ExponentPushToken[dead-device-3]';
    const liveToken = 'ExponentPushToken[live-device-4]';

    await store.upsertToken({ token: deadToken });
    await store.upsertToken({ token: liveToken });

    const now = 5000000;

    // Seed tickets that are ready to poll
    await store.saveTickets([
      {
        ticketId: 'ticket-dead',
        token: deadToken,
        sentAt: now - 20 * 60 * 1000,
        readyAt: now - 5 * 60 * 1000,
        expiresAt: now + 20 * 60 * 1000,
        attempts: 0,
        status: 'pending',
      },
      {
        ticketId: 'ticket-live',
        token: liveToken,
        sentAt: now - 20 * 60 * 1000,
        readyAt: now - 5 * 60 * 1000,
        expiresAt: now + 20 * 60 * 1000,
        attempts: 0,
        status: 'pending',
      },
    ]);

    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: {
          'ticket-dead': {
            status: 'error',
            message: 'DeviceNotRegistered',
            details: { error: 'DeviceNotRegistered' },
          },
          'ticket-live': {
            status: 'ok',
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

    expect(report.prunedTokens).toContain(deadToken);
    expect(report.resolvedTickets).toBe(2);

    // Assert dead token is deleted, live token is kept
    const currentTokens = (await store.listTokens()).map((t) => t.token);
    expect(currentTokens).not.toContain(deadToken);
    expect(currentTokens).toContain(liveToken);
  });
});
