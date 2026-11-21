import { describe, expect, it, vi } from 'vitest';
import { ExpoClient, ExpoValidationError } from '../expoClient.js';
import { InMemoryPushStore } from '../store.js';
import type { ExpoPushMessage } from '../types.js';

describe('4 KiB payload cap', () => {
  it('fails validation when payload exceeds 4,096 UTF-8 bytes before calling fetch', async () => {
    const store = new InMemoryPushStore();
    const fetchMock = vi.fn();
    const client = new ExpoClient({ store, fetch: fetchMock as unknown as typeof fetch });

    // Construct a large body that pushes total JSON UTF-8 byte length beyond 4,096 bytes
    const largeBody = 'A'.repeat(4100);
    const oversizedMessage: ExpoPushMessage = {
      to: 'ExponentPushToken[large-token]',
      title: 'Oversized Notification',
      body: largeBody,
    };

    await expect(client.sendNotifications([oversizedMessage])).rejects.toThrow(
      ExpoValidationError,
    );

    // Verify code is MessageTooBig
    try {
      await client.sendNotifications([oversizedMessage]);
    } catch (err) {
      expect((err as ExpoValidationError).code).toBe('MessageTooBig');
    }

    // Absolutely zero fetch calls should have been made
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows payloads exactly at or below 4,096 UTF-8 bytes', () => {
    const store = new InMemoryPushStore();
    const client = new ExpoClient({ store });

    const validMessage: ExpoPushMessage = {
      to: 'ExponentPushToken[valid-token]',
      title: 'Normal Notification',
      body: 'Standard payment notification',
      data: { txId: '12345' },
    };

    expect(() => client.validateMessagePayload(validMessage)).not.toThrow();
  });
});
