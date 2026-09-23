/**
 * HTTP server for the SPP bootnode service (#719).
 *
 * Endpoints
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * GET /healthz
 *   Liveness check.  Always returns 200 { ok: true } if the process is alive.
 *   Used by Render / Fly.io health checks and the wallet's fallback probe.
 *
 * GET /status
 *   Operational status: event count, last indexed ledger, indexer lag estimate,
 *   pool list, DB size, uptime.  Consumed by monitoring and docs/SPP_BOOTNODE.md
 *   storage verification steps.
 *
 * GET /events?pool=<addr>&fromLedger=<n>&limit=<n>
 *   The endpoint the SPP SDK queries at `bootnodeUrl`.  Returns a JSON array
 *   of events for the given pool starting at `fromLedger` (inclusive), up to
 *   `limit` rows (capped at 5 000).
 *
 *   Query params:
 *     pool        — Soroban contract address (required)
 *     fromLedger  — start ledger, inclusive (default: 0)
 *     limit       — max rows (default: 200, max: 5 000)
 *
 * CORS
 * ─────────────────────────────────────────────────────────────────────────────
 * Controlled by ALLOWED_ORIGINS env var (comma-separated).  Defaults to
 * accepting all origins (`*`) so a fresh local deployment works out of the box.
 * Restrict this in production to the wallet and mobile proxy origins.
 */

import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { createServer, type Server as HttpServer } from 'node:http';
import type Database from 'better-sqlite3';
import { countEvents, dbSizeBytes, indexedPools, queryEvents } from './db.js';
import { getIndexerStatus } from './indexer.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function allowedOrigins(): string[] | string {
  const raw = process.env['ALLOWED_ORIGINS']?.trim();
  if (!raw) return '*';
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface BootnodeServerOptions {
  port?: number;
  db: Database.Database;
}

export interface BootnodeServer {
  httpServer: HttpServer;
  close: () => Promise<void>;
}

export function createBootnodeServer(opts: BootnodeServerOptions): BootnodeServer {
  const port = opts.port ?? parseInt(process.env['PORT'] ?? '3002', 10);
  const db = opts.db;
  const startedAt = Date.now();

  const app = express();
  app.disable('x-powered-by');

  const origins = allowedOrigins();
  app.use(
    cors({
      origin: origins === '*' ? true : origins,
      methods: ['GET', 'OPTIONS'],
    }),
  );

  // ── GET /healthz ─────────────────────────────────────────────────────────

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // ── GET /status ──────────────────────────────────────────────────────────

  app.get('/status', (_req: Request, res: Response) => {
    const indexer = getIndexerStatus();
    const eventsCount = countEvents(db);
    const dbBytes = dbSizeBytes(db);
    const pools = indexedPools(db);
    const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);

    res.json({
      ok: true,
      eventsCount,
      lastIndexedLedger: indexer.lastIndexedLedger,
      pools,
      dbSizeBytes: dbBytes,
      dbSizeMb: +(dbBytes / 1_048_576).toFixed(2),
      pollIntervalMs: indexer.pollIntervalMs,
      lastPollAt: indexer.lastPollAt,
      lastError: indexer.lastError,
      running: indexer.running,
      uptimeSeconds,
    });
  });

  // ── GET /events ──────────────────────────────────────────────────────────

  app.get('/events', (req: Request, res: Response) => {
    const pool = typeof req.query['pool'] === 'string' ? req.query['pool'].trim() : '';
    if (!pool) {
      res.status(400).json({ error: 'pool query parameter is required' });
      return;
    }

    const fromLedger = Math.max(
      0,
      parseInt(typeof req.query['fromLedger'] === 'string' ? req.query['fromLedger'] : '0', 10) || 0,
    );
    const limit = Math.min(
      5000,
      Math.max(
        1,
        parseInt(typeof req.query['limit'] === 'string' ? req.query['limit'] : '200', 10) || 200,
      ),
    );

    const rows = queryEvents(db, { pool, fromLedger, limit });
    res.json({ events: rows, count: rows.length });
  });

  // ── 404 catch-all ────────────────────────────────────────────────────────

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });

  // ── Start listening ──────────────────────────────────────────────────────

  const httpServer = createServer(app);

  const shouldListen = process.env['NODE_ENV'] !== 'test';
  if (shouldListen) {
    httpServer.listen(port, () => {
      console.log(`[server] listening on http://localhost:${port}`);
      console.log(`[server] CORS origins: ${JSON.stringify(origins)}`);
    });
  }

  return {
    httpServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
