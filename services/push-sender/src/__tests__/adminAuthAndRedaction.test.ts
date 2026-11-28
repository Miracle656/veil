import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ExpoClient } from '../expoClient.js';
import { redactAuthHeaders, redactPushTokens, redactText } from '../redact.js';
import { createPushServer } from '../server.js';
import { InMemoryPushStore } from '../store.js';

describe('Admin route security & redaction', () => {
  it('returns 503 Service Unavailable when PUSH_ADMIN_TOKEN is unset or empty', async () => {
    const store = new InMemoryPushStore();
    const client = new ExpoClient({ store });
    const { app } = createPushServer({
      adminToken: '', // unset
      client,
      store,
    });

    const res = await request(app)
      .post('/admin/push/send')
      .send({ title: 'Test', body: 'Test', tokens: ['tok1'] });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain('Admin token not configured');
  });

  it('returns 401 Unauthorized for missing or invalid admin token', async () => {
    const store = new InMemoryPushStore();
    const client = new ExpoClient({ store });
    const { app } = createPushServer({
      adminToken: 'secret-admin-pass-123',
      client,
      store,
    });

    // 1. Missing header
    const resNoToken = await request(app)
      .post('/admin/push/send')
      .send({ title: 'Test', body: 'Test', tokens: ['tok1'] });
    expect(resNoToken.status).toBe(401);

    // 2. Invalid Bearer token
    const resWrongToken = await request(app)
      .post('/admin/push/send')
      .set('Authorization', 'Bearer wrong-secret-token')
      .send({ title: 'Test', body: 'Test', tokens: ['tok1'] });
    expect(resWrongToken.status).toBe(401);

    // 3. Invalid x-admin-token header
    const resWrongHeader = await request(app)
      .post('/admin/push/send')
      .set('x-admin-token', 'wrong-secret-token')
      .send({ title: 'Test', body: 'Test', tokens: ['tok1'] });
    expect(resWrongHeader.status).toBe(401);
  });

  it('allows access with valid Bearer or x-admin-token header', async () => {
    const store = new InMemoryPushStore();
    const client = new ExpoClient({ store });
    const { app } = createPushServer({
      adminToken: 'secret-admin-pass-123',
      client,
      store,
    });

    // Public /healthz works without token
    const health = await request(app).get('/healthz');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });

    // Valid Bearer token
    const resBearer = await request(app)
      .post('/admin/push/send')
      .set('Authorization', 'Bearer secret-admin-pass-123')
      .send({
        title: 'Payment Alert',
        body: 'You received 50 USDC',
        tokens: ['ExponentPushToken[device-test-1]'],
        dryRun: true,
      });
    expect(resBearer.status).toBe(200);
    expect(resBearer.body.ok).toBe(true);
    expect(resBearer.body.report.dryRun).toBe(true);

    // Valid x-admin-token header
    const resHeader = await request(app)
      .post('/admin/push/send')
      .set('x-admin-token', 'secret-admin-pass-123')
      .send({
        title: 'Payment Alert',
        body: 'You received 50 USDC',
        tokens: ['ExponentPushToken[device-test-1]'],
        dryRun: true,
      });
    expect(resHeader.status).toBe(200);
    expect(resHeader.body.ok).toBe(true);
  });

  it('attaches Authorization: Bearer <EXPO_ACCESS_TOKEN> when configured', async () => {
    const store = new InMemoryPushStore();
    const capturedHeaders: Headers[] = [];

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders.push(new Headers(init.headers as HeadersInit));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          data: [{ status: 'ok', id: 't-1' }],
        }),
      };
    });

    const client = new ExpoClient({
      store,
      fetch: fetchMock as unknown as typeof fetch,
      expoAccessToken: 'my-eas-expo-access-token-999',
    });

    await client.sendNotifications([
      { to: 'ExponentPushToken[dev-1]', title: 'Test', body: 'Test' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedHeaders[0].get('authorization')).toBe('Bearer my-eas-expo-access-token-999');
  });

  it('redacts tokens, authorization secrets, and URL keys from logs', () => {
    const rawError =
      'Failed call to https://exp.host/--/api/v2/push/send?key=secret-key for ExponentPushToken[abcdef12345] with Bearer super-secret-jwt-token';

    const redacted = redactText(rawError, ['super-secret-jwt-token', 'secret-key']);

    expect(redacted).not.toContain('ExponentPushToken[abcdef12345]');
    expect(redacted).toContain('ExponentPushToken[REDACTED]');

    expect(redacted).not.toContain('super-secret-jwt-token');
    expect(redacted).toContain('Bearer [REDACTED]');

    expect(redacted).not.toContain('secret-key');
    expect(redacted).toContain('https://exp.host/…');
  });
});
