/**
 * SPP bootnode service — entry point (#719).
 *
 * Boots the SQLite database, starts the event indexer, and starts the HTTP
 * server.  Handles SIGTERM/SIGINT gracefully so in-flight database writes
 * complete before the process exits.
 *
 * Usage:
 *   node src/index.js          (compiled)
 *   npx ts-node src/index.ts   (dev)
 *   npm run dev                (via ts-node-dev with --respawn)
 */

import 'dotenv/config';
import { openDb } from './db.js';
import { indexerConfigFromEnv, startIndexer } from './indexer.js';
import { createBootnodeServer } from './server.js';

// ---------------------------------------------------------------------------
// Config & startup
// ---------------------------------------------------------------------------

const DB_PATH =
  process.env['DB_PATH']?.trim() || './data/bootnode.db';

console.log('[boot] starting SPP bootnode service');
console.log(`[boot] database: ${DB_PATH}`);

const db = openDb(DB_PATH);
const config = indexerConfigFromEnv();

console.log(`[boot] RPC: ${config.rpcUrl}`);
console.log(`[boot] pools: ${config.poolAddresses.join(', ')}`);
console.log(`[boot] poll interval: ${config.pollIntervalMs} ms`);

const { stop: stopIndexer } = startIndexer(db, config);
const { close: closeServer } = createBootnodeServer({ db });

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[boot] received ${signal} — shutting down gracefully`);

  try {
    await Promise.all([stopIndexer(), closeServer()]);
    db.close();
    console.log('[boot] shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[boot] error during shutdown:', (err as Error).message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[boot] uncaughtException:', err);
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('[boot] unhandledRejection:', reason);
  void shutdown('unhandledRejection');
});
