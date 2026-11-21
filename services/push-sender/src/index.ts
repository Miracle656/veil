/**
 * Standalone server entrypoint for push-sender service (#1275).
 * Boots store, scheduler and Express HTTP server, and handles graceful shutdown.
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExpoClient } from './expoClient.js';
import { ReceiptScheduler } from './scheduler.js';
import { createPushServer } from './server.js';
import { JsonFilePushStore } from './store.js';

export function startPushService() {
  const isTest = process.env['NODE_ENV'] === 'test';
  const adminToken = process.env['PUSH_ADMIN_TOKEN']?.trim();

  if (!isTest && (!adminToken || adminToken.length === 0)) {
    throw new Error(
      '[push-sender] PUSH_ADMIN_TOKEN is required. Set it in .env before starting the server.',
    );
  }

  const port = parseInt(process.env['PORT'] ?? '3003', 10);
  const storePath = process.env['PUSH_STORE_PATH'] ?? './data/push-store.json';
  const expoAccessToken = process.env['EXPO_ACCESS_TOKEN']?.trim();
  const pollIntervalMs = parseInt(process.env['RECEIPT_POLL_INTERVAL_MS'] ?? '60000', 10);

  const store = new JsonFilePushStore(storePath);
  const client = new ExpoClient({
    store,
    expoAccessToken,
  });

  const scheduler = new ReceiptScheduler(client, {
    intervalMs: pollIntervalMs,
  });

  const server = createPushServer({
    port,
    adminToken,
    client,
    store,
    scheduler,
    autoListen: !isTest,
  });

  if (!isTest) {
    scheduler.start();
    console.log(`[push-sender] Receipt polling scheduler active (interval: ${pollIntervalMs}ms)`);
  }

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[push-sender] Caught ${signal}, gracefully shutting down...`);

    try {
      await scheduler.stop();
      console.log('[push-sender] Receipt scheduler stopped.');
      await server.close();
      console.log('[push-sender] HTTP server closed.');
      process.exit(0);
    } catch (err) {
      console.error('[push-sender] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return { store, client, scheduler, server };
}

// Start if executed directly
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  startPushService();
}
