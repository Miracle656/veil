/**
 * Express HTTP server exposing health check and authenticated admin routes (#1275).
 * Mirrors patterns from services/spp-bootnode/src/server.ts and packages/agent/src/server.ts.
 */

import cors from 'cors';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ExpoClient } from './expoClient.js';
import { redactText } from './redact.js';
import type { ReceiptScheduler } from './scheduler.js';
import type { PushStore } from './store.js';
import type { ExpoPushMessage } from './types.js';

export interface PushServerOptions {
  port?: number;
  adminToken?: string;
  client: ExpoClient;
  store: PushStore;
  scheduler?: ReceiptScheduler;
  autoListen?: boolean;
}

export interface PushServerInstance {
  app: express.Express;
  httpServer: HttpServer;
  close: () => Promise<void>;
}

/**
 * Constant-time string comparison to defend against timing attacks (#1275).
 * Mirrors packages/agent/src/server.ts.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Extract bearer or header admin token from request. */
export function extractAdminToken(req: Request): string {
  const header = req.headers['authorization'];
  if (header && typeof header === 'string') {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }

  const customHeader = req.headers['x-admin-token'];
  if (typeof customHeader === 'string' && customHeader) {
    return customHeader.trim();
  }

  return '';
}

export function createPushServer(options: PushServerOptions): PushServerInstance {
  const port = options.port ?? parseInt(process.env['PORT'] ?? '3003', 10);
  const adminToken = options.adminToken ?? process.env['PUSH_ADMIN_TOKEN']?.trim();
  const client = options.client;
  const store = options.store;
  const scheduler = options.scheduler;

  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // ── Public Routes ──────────────────────────────────────────────────────────

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // ── Admin Authentication Middleware ────────────────────────────────────────

  const requireAdminAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!adminToken || adminToken.length === 0) {
      // Fail closed when admin token is not configured
      res.status(503).json({ error: 'Admin token not configured on server' });
      return;
    }

    const provided = extractAdminToken(req);
    if (!provided || !timingSafeEqualStr(provided, adminToken)) {
      res.status(401).json({ error: 'Unauthorized: invalid or missing admin token' });
      return;
    }

    next();
  };

  // ── Admin-Only Routes ──────────────────────────────────────────────────────

  /**
   * POST /admin/push/send
   * Send push notifications or preview a dry run.
   */
  app.post('/admin/push/send', requireAdminAuth, async (req: Request, res: Response) => {
    try {
      const { title, body, data, projectId, tokens, messages, dryRun } = req.body as {
        title?: string;
        body?: string;
        data?: Record<string, unknown>;
        projectId?: string;
        tokens?: string[];
        messages?: ExpoPushMessage[];
        dryRun?: boolean;
      };

      const outboundMessages: ExpoPushMessage[] = [];

      if (Array.isArray(messages) && messages.length > 0) {
        outboundMessages.push(...messages);
      } else if (Array.isArray(tokens) && tokens.length > 0) {
        if (!title && !body) {
          res.status(400).json({ error: 'Either title or body is required when sending to tokens' });
          return;
        }
        for (const token of tokens) {
          outboundMessages.push({
            to: token,
            title,
            body,
            data,
            projectId,
          });
        }
      } else {
        res.status(400).json({
          error: 'Must provide either a list of `tokens` with `title`/`body`, or an array of `messages`',
        });
        return;
      }

      const report = await client.sendNotifications(outboundMessages, { dryRun: !!dryRun });
      res.json({ ok: true, report });
    } catch (err) {
      const errorMsg = redactText((err as Error).message, [adminToken]);
      res.status(400).json({ error: errorMsg });
    }
  });

  /**
   * POST /admin/push/poll-receipts
   * Manually trigger receipt polling.
   */
  app.post('/admin/push/poll-receipts', requireAdminAuth, async (_req: Request, res: Response) => {
    try {
      const report = await client.pollReceipts();
      res.json({ ok: true, report });
    } catch (err) {
      const errorMsg = redactText((err as Error).message, [adminToken]);
      res.status(500).json({ error: errorMsg });
    }
  });

  /**
   * GET /admin/push/status
   * Operational status and diagnostic counts.
   */
  app.get('/admin/push/status', requireAdminAuth, async (_req: Request, res: Response) => {
    try {
      const tokens = await store.listTokens();
      const pendingTickets = await store.listPendingTickets();
      const schedulerStatus = scheduler?.getStatus() ?? null;

      res.json({
        ok: true,
        tokensCount: tokens.length,
        pendingTicketsCount: pendingTickets.length,
        scheduler: schedulerStatus,
      });
    } catch (err) {
      const errorMsg = redactText((err as Error).message, [adminToken]);
      res.status(500).json({ error: errorMsg });
    }
  });

  /**
   * POST /admin/push/tokens
   * Register or upsert a device push token.
   */
  app.post('/admin/push/tokens', requireAdminAuth, async (req: Request, res: Response) => {
    const { token, projectId } = req.body as { token?: string; projectId?: string };
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Valid `token` string is required' });
      return;
    }

    try {
      await store.upsertToken({ token: token.trim(), projectId: projectId?.trim() });
      res.json({ ok: true, token: token.trim() });
    } catch (err) {
      const errorMsg = redactText((err as Error).message, [adminToken]);
      res.status(500).json({ error: errorMsg });
    }
  });

  /**
   * DELETE /admin/push/tokens/:token
   * Delete / prune a device push token.
   */
  app.delete('/admin/push/tokens/:token', requireAdminAuth, async (req: Request, res: Response) => {
    const token = req.params['token'];
    if (!token) {
      res.status(400).json({ error: 'Token parameter is required' });
      return;
    }

    try {
      const deleted = await store.deleteToken(token);
      res.json({ ok: true, deleted });
    } catch (err) {
      const errorMsg = redactText((err as Error).message, [adminToken]);
      res.status(500).json({ error: errorMsg });
    }
  });

  // ── 404 Catch-All ──────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  const httpServer = createServer(app);

  if (options.autoListen) {
    httpServer.listen(port, () => {
      console.log(`[push-sender] Server listening on http://localhost:${port}`);
    });
  }

  return {
    app,
    httpServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
