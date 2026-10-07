/**
 * SQLite schema and query helpers for the SPP bootnode.
 *
 * Schema design
 * ─────────────────────────────────────────────────────────────────────────────
 * One table stores every pool event row received from the Soroban RPC
 * `getEvents` method.  The primary key is (ledger, tx_hash, event_idx), which
 * matches the RPC's own deduplication guarantee — submitting the same event
 * twice is idempotent because SQLite INSERT OR IGNORE skips the duplicate.
 *
 * Storage estimate (see docs/SPP_BOOTNODE.md for full table):
 *   • Each row: ~300–400 bytes (fields + index overhead)
 *   • 10 000 events ≈ 3–4 MB
 *   • Testnet traffic (Aug 2026 baseline): ~180 events/month
 *
 * A second table, `checkpoint`, stores a single row with the highest ledger
 * fully indexed.  The indexer reads this on startup to resume without re-scanning
 * the entire history.
 *
 * DEPENDENCIES
 * ─────────────────────────────────────────────────────────────────────────────
 * better-sqlite3 is a synchronous SQLite binding that is simpler to use in a
 * Node.js indexing loop than async alternatives (no callback hell, no missed
 * awaits).  It is safe here because the indexer is single-threaded.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PoolEvent {
  ledger: number;
  txHash: string;
  eventIdx: number;
  pool: string;
  topic0: string;
  topic1: string | null;
  topic2: string | null;
  valueXdr: string;
}

export interface Checkpoint {
  lastLedger: number;
}

// ---------------------------------------------------------------------------
// Open / initialise
// ---------------------------------------------------------------------------

/**
 * Open (or create) the SQLite database at `dbPath` and ensure the schema is
 * up to date.  Safe to call on every startup — the CREATE TABLE IF NOT EXISTS
 * and CREATE INDEX IF NOT EXISTS statements are idempotent.
 */
export function openDb(dbPath: string): Database.Database {
  // Create the parent directory if it does not exist (e.g. first run).
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance (the HTTP server
  // reads while the indexer writes).
  db.pragma('journal_mode = WAL');
  // Increase cache to 8 MB to speed up range scans.
  db.pragma('cache_size = -8000');
  // Synchronise at normal level — we can tolerate losing the last few seconds
  // of events on a crash since the indexer will re-scan from the checkpoint.
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS pool_events (
      ledger     INTEGER NOT NULL,
      tx_hash    TEXT    NOT NULL,
      event_idx  INTEGER NOT NULL,
      pool       TEXT    NOT NULL,
      topic0     TEXT    NOT NULL,
      topic1     TEXT,
      topic2     TEXT,
      value_xdr  TEXT    NOT NULL,
      PRIMARY KEY (ledger, tx_hash, event_idx)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS pool_events_pool_ledger
      ON pool_events (pool, ledger);

    CREATE TABLE IF NOT EXISTS checkpoint (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      last_ledger INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    -- Ensure the single checkpoint row exists.
    INSERT OR IGNORE INTO checkpoint (id, last_ledger) VALUES (1, 0);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Checkpoint helpers
// ---------------------------------------------------------------------------

/** Read the last fully indexed ledger.  Returns 0 on a fresh database. */
export function getCheckpoint(db: Database.Database): number {
  const row = db
    .prepare<[], { last_ledger: number }>('SELECT last_ledger FROM checkpoint WHERE id = 1')
    .get();
  return row?.last_ledger ?? 0;
}

/** Persist the last fully indexed ledger. */
export function setCheckpoint(db: Database.Database, ledger: number): void {
  db
    .prepare<[number]>('UPDATE checkpoint SET last_ledger = ? WHERE id = 1')
    .run(ledger);
}

// ---------------------------------------------------------------------------
// Event insert
// ---------------------------------------------------------------------------

/**
 * Insert a batch of pool events atomically.
 *
 * Uses INSERT OR IGNORE so re-indexing the same ledger range (e.g. after a
 * crash) is safe — duplicates are silently skipped.
 *
 * Returns the number of newly inserted rows.
 */
export function insertEvents(
  db: Database.Database,
  events: PoolEvent[],
): number {
  if (events.length === 0) return 0;

  const stmt = db.prepare<[number, string, number, string, string, string | null, string | null, string]>(`
    INSERT OR IGNORE INTO pool_events
      (ledger, tx_hash, event_idx, pool, topic0, topic1, topic2, value_xdr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows: PoolEvent[]) => {
    let inserted = 0;
    for (const r of rows) {
      const info = stmt.run(
        r.ledger,
        r.txHash,
        r.eventIdx,
        r.pool,
        r.topic0,
        r.topic1 ?? null,
        r.topic2 ?? null,
        r.valueXdr,
      );
      inserted += info.changes;
    }
    return inserted;
  });

  return insertMany(events) as number;
}

// ---------------------------------------------------------------------------
// Query helpers (used by the HTTP server)
// ---------------------------------------------------------------------------

export interface EventQueryParams {
  pool: string;
  fromLedger: number;
  limit: number;
}

export interface EventRow {
  ledger: number;
  txHash: string;
  eventIdx: number;
  topic0: string;
  topic1: string | null;
  topic2: string | null;
  valueXdr: string;
}

/**
 * Return up to `limit` events for `pool` starting from `fromLedger`
 * (inclusive), ordered by ledger ascending.
 */
export function queryEvents(
  db: Database.Database,
  params: EventQueryParams,
): EventRow[] {
  const rows = db
    .prepare<[string, number, number], {
      ledger: number;
      tx_hash: string;
      event_idx: number;
      topic0: string;
      topic1: string | null;
      topic2: string | null;
      value_xdr: string;
    }>(`
      SELECT ledger, tx_hash, event_idx, topic0, topic1, topic2, value_xdr
      FROM   pool_events
      WHERE  pool = ?
        AND  ledger >= ?
      ORDER  BY ledger ASC, tx_hash ASC, event_idx ASC
      LIMIT  ?
    `)
    .all(params.pool, params.fromLedger, Math.min(params.limit, 5000));

  return rows.map((r) => ({
    ledger: r.ledger,
    txHash: r.tx_hash,
    eventIdx: r.event_idx,
    topic0: r.topic0,
    topic1: r.topic1,
    topic2: r.topic2,
    valueXdr: r.value_xdr,
  }));
}

/** Total event count across all pools (for /status). */
export function countEvents(db: Database.Database): number {
  const row = db
    .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM pool_events')
    .get();
  return row?.n ?? 0;
}

/** Approximate database size in bytes (for /status). */
export function dbSizeBytes(db: Database.Database): number {
  const row = db
    .prepare<[], { size: number }>(
      "SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()",
    )
    .get();
  return row?.size ?? 0;
}

/** List of distinct pool addresses indexed so far. */
export function indexedPools(db: Database.Database): string[] {
  return db
    .prepare<[], { pool: string }>('SELECT DISTINCT pool FROM pool_events')
    .all()
    .map((r) => r.pool);
}
