import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';
import { ExpoClient } from '../expoClient.js';
import { InMemoryPushStore } from '../store.js';
import type { ExpoPushMessage } from '../types.js';

describe('Dry-run mode (service + CLI)', () => {
  it('ExpoClient dryRun: true makes 0 fetch calls and writes 0 tickets', async () => {
    const store = new InMemoryPushStore();
    const fetchMock = vi.fn();
    const client = new ExpoClient({ store, fetch: fetchMock as unknown as typeof fetch });

    const messages: ExpoPushMessage[] = [
      { to: 'ExponentPushToken[tok-1]', title: 'Payment', body: 'Received 100 USDC', projectId: 'p1' },
      { to: 'ExponentPushToken[tok-2]', title: 'Payment', body: 'Received 100 USDC', projectId: 'p2' },
    ];

    const result = await client.sendNotifications(messages, { dryRun: true });

    expect('dryRun' in result && result.dryRun).toBe(true);
    if ('dryRun' in result) {
      expect(result.totalMessages).toBe(2);
      expect(result.totalDevices).toBe(2);
      expect(result.projectBreakdown).toEqual({ p1: 1, p2: 1 });
      expect(result.batches).toBe(2);
    }

    // Zero fetch calls
    expect(fetchMock).not.toHaveBeenCalled();

    // Zero tickets written
    const tickets = await store.listPendingTickets();
    expect(tickets).toHaveLength(0);
  });

  it('CLI --dry-run prints plan, makes 0 calls, and exits 0', async () => {
    const logs: string[] = [];
    const errors: string[] = [];

    const mockOutput = {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    };

    const code = await runCli(
      [
        'send',
        '--title',
        'Veil Deposit',
        '--body',
        'Your transfer has settled',
        '--token',
        'ExponentPushToken[device-dry-1]',
        '--token',
        'ExponentPushToken[device-dry-2]',
        '--dry-run',
      ],
      mockOutput,
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const fullLog = logs.join('\n');
    expect(fullLog).toContain('=== DRY-RUN PLAN ===');
    expect(fullLog).toContain('Total messages : 2');
    expect(fullLog).toContain('Total devices  : 2');
    expect(fullLog).toContain('Zero network calls were made. Zero tickets were written.');
  });
});
