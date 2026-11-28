import { describe, expect, it, vi } from 'vitest';
import { ExpoClient } from '../expoClient.js';
import { InMemoryPushStore } from '../store.js';
import type { ExpoPushMessage } from '../types.js';

describe('Batch splitting & project grouping', () => {
  it('splits 101 messages for 1 project into 2 requests of 100 and 1', async () => {
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

    const client = new ExpoClient({ store, fetch: fetchMock as unknown as typeof fetch });

    const messages: ExpoPushMessage[] = Array.from({ length: 101 }, (_, i) => ({
      to: `ExponentPushToken[token-${i}]`,
      title: 'Title',
      body: 'Body',
      projectId: 'proj-1',
    }));

    const report = await client.sendNotifications(messages);

    expect('batches' in report && report.batches).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBatch = JSON.parse(fetchMock.mock.calls[0][1].body) as ExpoPushMessage[];
    const secondBatch = JSON.parse(fetchMock.mock.calls[1][1].body) as ExpoPushMessage[];

    expect(firstBatch).toHaveLength(100);
    expect(secondBatch).toHaveLength(1);
    expect(firstBatch.every((m) => m.projectId === 'proj-1')).toBe(true);
    expect(secondBatch[0].projectId).toBe('proj-1');
  });

  it('splits 250 messages for 1 project into 3 requests of 100, 100, and 50', async () => {
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

    const client = new ExpoClient({ store, fetch: fetchMock as unknown as typeof fetch });

    const messages: ExpoPushMessage[] = Array.from({ length: 250 }, (_, i) => ({
      to: `ExponentPushToken[token-${i}]`,
      title: 'Batch test',
      body: 'Testing chunks',
      projectId: 'proj-alpha',
    }));

    const report = await client.sendNotifications(messages);

    expect('batches' in report && report.batches).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const b1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    const b2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    const b3 = JSON.parse(fetchMock.mock.calls[2][1].body);

    expect(b1).toHaveLength(100);
    expect(b2).toHaveLength(100);
    expect(b3).toHaveLength(50);
  });

  it('never combines messages spanning 2 projects in the same HTTP request', async () => {
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

    const client = new ExpoClient({ store, fetch: fetchMock as unknown as typeof fetch });

    // 10 messages for project-A, 10 messages for project-B
    const messages: ExpoPushMessage[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        to: `ExponentPushToken[token-A-${i}]`,
        title: 'Project A',
        projectId: 'project-A',
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        to: `ExponentPushToken[token-B-${i}]`,
        title: 'Project B',
        projectId: 'project-B',
      })),
    ];

    const report = await client.sendNotifications(messages);

    expect('batches' in report && report.batches).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const req1 = JSON.parse(fetchMock.mock.calls[0][1].body) as ExpoPushMessage[];
    const req2 = JSON.parse(fetchMock.mock.calls[1][1].body) as ExpoPushMessage[];

    const projectsInReq1 = new Set(req1.map((m) => m.projectId));
    const projectsInReq2 = new Set(req2.map((m) => m.projectId));

    expect(projectsInReq1.size).toBe(1);
    expect(projectsInReq2.size).toBe(1);
    expect(projectsInReq1.has('project-A')).toBe(true);
    expect(projectsInReq2.has('project-B')).toBe(true);
  });
});
