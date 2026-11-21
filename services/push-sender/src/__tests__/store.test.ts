import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryPushStore, JsonFilePushStore } from '../store.js';

describe('PushStore implementations', () => {
  it('InMemoryPushStore manages tokens and tickets correctly', async () => {
    const store = new InMemoryPushStore();

    // 1. Tokens
    await store.upsertToken({ token: 'ExponentPushToken[1]', projectId: 'proj-1' });
    await store.upsertToken({ token: 'ExponentPushToken[2]', projectId: 'proj-2' });

    let tokens = await store.listTokens();
    expect(tokens).toHaveLength(2);

    tokens = await store.listTokens('proj-1');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe('ExponentPushToken[1]');

    await store.deleteToken('ExponentPushToken[1]');
    tokens = await store.listTokens();
    expect(tokens).toHaveLength(1);

    // 2. Tickets
    const now = Date.now();
    await store.saveTickets([
      {
        ticketId: 'tick-1',
        token: 'ExponentPushToken[2]',
        sentAt: now,
        readyAt: now - 100, // due
        expiresAt: now + 100000,
        attempts: 0,
        status: 'pending',
      },
      {
        ticketId: 'tick-2',
        token: 'ExponentPushToken[2]',
        sentAt: now,
        readyAt: now + 50000, // not due
        expiresAt: now + 100000,
        attempts: 0,
        status: 'pending',
      },
    ]);

    let due = await store.listDueTickets(now);
    expect(due).toHaveLength(1);
    expect(due[0].ticketId).toBe('tick-1');

    await store.markTicketsResolved(['tick-1']);
    due = await store.listDueTickets(now);
    expect(due).toHaveLength(0);

    const pending = await store.listPendingTickets();
    expect(pending).toHaveLength(1);
    expect(pending[0].ticketId).toBe('tick-2');
  });

  it('JsonFilePushStore persists data atomically and reloads across instances', async () => {
    const tmpDir = path.resolve('./node_modules/.tmp-store-test');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const filePath = path.join(tmpDir, `store-${Date.now()}.json`);

    try {
      const store1 = new JsonFilePushStore(filePath);

      await store1.upsertToken({ token: 'ExponentPushToken[persisted]', projectId: 'p-saved' });
      await store1.saveTickets([
        {
          ticketId: 'saved-ticket',
          token: 'ExponentPushToken[persisted]',
          sentAt: 1000,
          readyAt: 2000,
          expiresAt: 5000,
          attempts: 0,
          status: 'pending',
        },
      ]);

      expect(fs.existsSync(filePath)).toBe(true);

      // Load with fresh instance reading the same file
      const store2 = new JsonFilePushStore(filePath);

      const tokens = await store2.listTokens();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].token).toBe('ExponentPushToken[persisted]');

      const tickets = await store2.listPendingTickets();
      expect(tickets).toHaveLength(1);
      expect(tickets[0].ticketId).toBe('saved-ticket');
    } finally {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  });
});
