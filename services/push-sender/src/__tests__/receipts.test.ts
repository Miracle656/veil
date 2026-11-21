import { describe, expect, it, vi } from 'vitest';
import { ExpoClient, RECEIPT_DELAY_MS, RECEIPT_TTL_MS } from '../expoClient.js';
import { ReceiptScheduler } from '../scheduler.js';
import { InMemoryPushStore } from '../store.js';
import type { ExpoPushMessage, StoredPushTicket } from '../types.js';

describe('Ticket storage & scheduled receipt polling', () => {
  it('correlates tickets positionally and links ticket ID to exact token', async () => {
    const store = new InMemoryPushStore();
    let now = 1000000;

    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: [
          { status: 'ok', id: 'ticket-token-0' },
          { status: 'ok', id: 'ticket-token-1' },
          { status: 'ok', id: 'ticket-token-2' },
        ],
      }),
    }));

    const client = new ExpoClient({
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });

    const messages: ExpoPushMessage[] = [
      { to: 'ExponentPushToken[user-0]', title: 'Msg 0' },
      { to: 'ExponentPushToken[user-1]', title: 'Msg 1' },
      { to: 'ExponentPushToken[user-2]', title: 'Msg 2' },
    ];

    await client.sendNotifications(messages);

    const pending = await store.listPendingTickets();
    expect(pending).toHaveLength(3);

    const t0 = pending.find((t) => t.ticketId === 'ticket-token-0');
    const t1 = pending.find((t) => t.ticketId === 'ticket-token-1');
    const t2 = pending.find((t) => t.ticketId === 'ticket-token-2');

    expect(t0?.token).toBe('ExponentPushToken[user-0]');
    expect(t1?.token).toBe('ExponentPushToken[user-1]');
    expect(t2?.token).toBe('ExponentPushToken[user-2]');

    expect(t0?.readyAt).toBe(now + RECEIPT_DELAY_MS);
    expect(t0?.expiresAt).toBe(now + RECEIPT_TTL_MS);
  });

  it('skips tickets before 15-minute readyAt threshold and polls them once due', async () => {
    const store = new InMemoryPushStore();
    let currentTime = 1000000;

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { ids: string[] };
      const data: Record<string, { status: string }> = {};
      for (const id of body.ids) {
        data[id] = { status: 'ok' };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data }),
      };
    });

    const client = new ExpoClient({
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => currentTime,
    });

    // Seed ticket with readyAt in 15 minutes
    await store.saveTickets([
      {
        ticketId: 't-123',
        token: 'ExponentPushToken[tok-1]',
        sentAt: currentTime,
        readyAt: currentTime + RECEIPT_DELAY_MS,
        expiresAt: currentTime + RECEIPT_TTL_MS,
        attempts: 0,
        status: 'pending',
      },
    ]);

    const scheduler = new ReceiptScheduler(client);

    // Poll at t + 5 minutes: not due yet!
    currentTime += 5 * 60 * 1000;
    const report1 = await scheduler.runOnce();
    expect(report1.polledTickets).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // Advance to t + 15 minutes: now it is due!
    currentTime += 10 * 60 * 1000;
    const report2 = await scheduler.runOnce();
    expect(report2.polledTickets).toBe(1);
    expect(report2.resolvedTickets).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const pendingAfter = await store.listPendingTickets();
    expect(pendingAfter).toHaveLength(0);
  });

  it('batches > 1,000 due tickets into chunks of <= 1,000 IDs per getReceipts request', async () => {
    const store = new InMemoryPushStore();
    const now = 2000000;

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { ids: string[] };
      const data: Record<string, { status: string }> = {};
      for (const id of body.ids) {
        data[id] = { status: 'ok' };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ data }),
      };
    });

    const client = new ExpoClient({
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });

    // Seed 1,050 tickets that are ready
    const tickets: StoredPushTicket[] = Array.from({ length: 1050 }, (_, i) => ({
      ticketId: `t-${i}`,
      token: `ExponentPushToken[tok-${i}]`,
      sentAt: now - RECEIPT_DELAY_MS - 1000,
      readyAt: now - 1000,
      expiresAt: now + RECEIPT_TTL_MS,
      attempts: 0,
      status: 'pending',
    }));
    await store.saveTickets(tickets);

    const report = await client.pollReceipts();

    expect(report.polledTickets).toBe(1050);
    expect(report.resolvedTickets).toBe(1050);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const req1 = JSON.parse(fetchMock.mock.calls[0][1].body) as { ids: string[] };
    const req2 = JSON.parse(fetchMock.mock.calls[1][1].body) as { ids: string[] };

    expect(req1.ids).toHaveLength(1000);
    expect(req2.ids).toHaveLength(50);
  });

  it('keeps omitted receipts pending when Expo has not generated receipt yet', async () => {
    const store = new InMemoryPushStore();
    const now = 3000000;

    // Expo returns receipt for t-1, but omits t-2
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: {
          't-1': { status: 'ok' },
        },
      }),
    }));

    const client = new ExpoClient({
      store,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });

    await store.saveTickets([
      {
        ticketId: 't-1',
        token: 'ExponentPushToken[tok-1]',
        sentAt: now - RECEIPT_DELAY_MS - 1000,
        readyAt: now - 1000,
        expiresAt: now + RECEIPT_TTL_MS,
        attempts: 0,
        status: 'pending',
      },
      {
        ticketId: 't-2',
        token: 'ExponentPushToken[tok-2]',
        sentAt: now - RECEIPT_DELAY_MS - 1000,
        readyAt: now - 1000,
        expiresAt: now + RECEIPT_TTL_MS,
        attempts: 0,
        status: 'pending',
      },
    ]);

    const report = await client.pollReceipts();
    expect(report.resolvedTickets).toBe(1);
    expect(report.pendingTickets).toBe(1);

    const pending = await store.listPendingTickets();
    expect(pending).toHaveLength(1);
    expect(pending[0].ticketId).toBe('t-2');
  });

  it('expires tickets past the 24-hour retention window', async () => {
    const store = new InMemoryPushStore();
    let now = 10000000;

    const client = new ExpoClient({
      store,
      now: () => now,
    });

    await store.saveTickets([
      {
        ticketId: 't-expired',
        token: 'ExponentPushToken[tok-exp]',
        sentAt: now - RECEIPT_TTL_MS - 1000,
        readyAt: now - RECEIPT_TTL_MS + RECEIPT_DELAY_MS,
        expiresAt: now - 1, // expired!
        attempts: 0,
        status: 'pending',
      },
    ]);

    const report = await client.pollReceipts();
    expect(report.expiredTickets).toBe(1);
    expect(report.pendingTickets).toBe(0);

    const pending = await store.listPendingTickets();
    expect(pending).toHaveLength(0);
  });
});
