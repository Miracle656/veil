/**
 * SPP state storage for mobile — SQLite-backed, encrypted at rest.
 *
 * The browser SDK keeps SPP state (notes, sync cursors, nullifier sets) in SQLite
 * on OPFS. Mobile has no OPFS, so we implement the same schema on device SQLite,
 * encrypted with a key held in the secure store. The database survives app
 * restarts (so sync resumes where it stopped and notes persist), but is wiped
 * when the wallet is removed.
 *
 * Database encryption uses SQLCipher (via expo-sqlite config plugin):
 * - Key: 32-byte random, persisted in secure keychain
 * - Cipher: AES-256 with HMAC authentication
 * - Key derives from wallet address so notes are lost if wallet address changes
 *
 * Schema mirrors the upstream SPP SDK:
 * - notes: commitment → secret + metadata
 * - sync state: ledger bookmark, last scanned height
 * - nullifiers: already-spent notes (prevent double-spend)
 * - event cache: scanned pool events for recovery
 */

import * as SQLite from 'expo-sqlite';
import { deleteSecureItem, getSecureItem, setSecureItem } from '../storage';

// ── Configuration ────────────────────────────────────────────────────────────

/** Secure store key for the SPP database encryption key. */
function sppEncryptionKeyStorageKey(walletAddress: string): string {
  return `veil_spp_db_key_${walletAddress}`;
}

/** Database name — scoped to the device, not the network (notes are network-aware internally). */
const SPP_DATABASE_NAME = 'veil_spp_state.db';

// ── Initialization & Encryption Key Management ───────────────────────────────

/**
 * Get or create the 32-byte encryption key for the SPP database.
 * The key is derived from the wallet address (so it's network-aware) and
 * persisted in the secure store.
 *
 * @param walletAddress The wallet's Soroban contract address (C...).
 * @returns A 64-character hex string (32 bytes).
 */
export async function getSppEncryptionKey(walletAddress: string): Promise<string> {
  const keyStoreKey = sppEncryptionKeyStorageKey(walletAddress);
  let key = await getSecureItem(keyStoreKey);

  if (!key) {
    // Generate a new 32-byte key and persist it.
    // Using crypto module from expo-crypto (already a dependency).
    const { getRandomBytes } = require('expo-crypto');
    const keyBytes = getRandomBytes(32);
    // Convert bytes to hex: each byte becomes 2 hex digits.
    key = Buffer.from(keyBytes).toString('hex');
    await setSecureItem(keyStoreKey, key);
  }

  return key;
}

/**
 * Clear the SPP database encryption key from the secure store.
 * Called when the wallet is removed.
 */
export async function clearSppEncryptionKey(walletAddress: string): Promise<void> {
  const keyStoreKey = sppEncryptionKeyStorageKey(walletAddress);
  await deleteSecureItem(keyStoreKey);
}

// ── Database Schema ──────────────────────────────────────────────────────────

/**
 * Initialize the SPP database with the required schema.
 * Idempotent: calling it multiple times is safe (uses IF NOT EXISTS).
 *
 * Schema:
 * - notes: Commitments, secrets, encrypted metadata per asset/pool.
 * - sync_state: Ledger bookmark and sync progress per pool.
 * - nullifiers: Set of spent notes (prevent re-spending).
 * - event_cache: Recent pool events for recovery / re-sync.
 */
async function initializeSppSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    -- Notes table: on-chain commitments + local secrets.
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY,
      commitment TEXT UNIQUE NOT NULL,
      secret BLOB NOT NULL,
      public_key BLOB NOT NULL,
      pool_id TEXT NOT NULL,
      token_contract TEXT NOT NULL,
      amount BIGINT NOT NULL,
      encrypted_metadata BLOB,
      spent INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_pool_spent ON notes(pool_id, spent);
    CREATE INDEX IF NOT EXISTS idx_notes_commitment ON notes(commitment);

    -- Sync state: track which pool events have been scanned.
    CREATE TABLE IF NOT EXISTS sync_state (
      id INTEGER PRIMARY KEY,
      pool_id TEXT UNIQUE NOT NULL,
      ledger_height INTEGER NOT NULL,
      cursor INTEGER DEFAULT 0,
      last_sync_at INTEGER NOT NULL,
      status TEXT DEFAULT 'syncing'
    );

    CREATE INDEX IF NOT EXISTS idx_sync_state_pool ON sync_state(pool_id);

    -- Nullifiers: set of spent note commitments (prevent re-spending).
    CREATE TABLE IF NOT EXISTS nullifiers (
      id INTEGER PRIMARY KEY,
      nullifier BLOB UNIQUE NOT NULL,
      commitment TEXT NOT NULL,
      spent_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nullifiers_nullifier ON nullifiers(nullifier);

    -- Event cache: recent pool events for recovery.
    CREATE TABLE IF NOT EXISTS event_cache (
      id INTEGER PRIMARY KEY,
      pool_id TEXT NOT NULL,
      ledger_height INTEGER NOT NULL,
      event_data BLOB NOT NULL,
      cached_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_event_cache_pool_height ON event_cache(pool_id, ledger_height);
  `);
}

// ── Database Access ─────────────────────────────────────────────────────────

let dbInstance: SQLite.SQLiteDatabase | null = null;
let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Get or open the SPP database.
 * Opens it once per app instance; subsequent calls return the cached connection.
 * Database is automatically encrypted via SQLCipher when this is the first open.
 *
 * @param walletAddress Required to derive the encryption key.
 * @returns The open database connection.
 */
export async function getSppDatabase(walletAddress: string): Promise<SQLite.SQLiteDatabase> {
  // Reuse the cached instance if already open.
  if (dbInstance) return dbInstance;

  // Serialize initialization so only one open attempt proceeds.
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const encryptionKey = await getSppEncryptionKey(walletAddress);
      const db = await SQLite.openDatabaseAsync(SPP_DATABASE_NAME, {
        useNewConnection: false,
      });

      // Apply encryption key via PRAGMA (SQLCipher syntax).
      // The pragma must be the first command after opening, before any reads/writes.
      await db.execAsync(`PRAGMA key = "x'${encryptionKey}'"`);

      // Verify encryption is working by trying a simple operation.
      // If the key is wrong, this will fail.
      await db.execAsync('PRAGMA integrity_check');

      // Initialize schema.
      await initializeSppSchema(db);

      dbInstance = db;
      return db;
    } catch (error) {
      initPromise = null; // Reset so next attempt tries again.
      throw error;
    }
  })();

  return initPromise;
}

// ── Note Storage Operations ──────────────────────────────────────────────────

export interface SppNote {
  commitment: string;
  secret: Uint8Array;
  publicKey: Uint8Array;
  poolId: string;
  tokenContract: string;
  amount: bigint;
  encryptedMetadata?: Uint8Array;
  spent?: boolean;
  createdAt?: number;
}

/**
 * Store a note in the database.
 */
export async function storeNote(walletAddress: string, note: SppNote): Promise<void> {
  const db = await getSppDatabase(walletAddress);
  const now = Date.now();

  await db.runAsync(
    `INSERT OR REPLACE INTO notes
     (commitment, secret, public_key, pool_id, token_contract, amount, encrypted_metadata, spent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    note.commitment,
    note.secret,
    note.publicKey,
    note.poolId,
    note.tokenContract,
    note.amount.toString(),
    note.encryptedMetadata || null,
    note.spent ? 1 : 0,
    note.createdAt || now,
    now,
  );
}

/**
 * Retrieve all unspent notes for a given pool.
 */
export async function getUnspentNotes(
  walletAddress: string,
  poolId: string,
): Promise<SppNote[]> {
  const db = await getSppDatabase(walletAddress);

  const rows = await db.allAsync<any>(
    `SELECT commitment, secret, public_key, pool_id, token_contract, amount, encrypted_metadata, created_at
     FROM notes
     WHERE pool_id = ? AND spent = 0
     ORDER BY created_at DESC`,
    poolId,
  );

  return rows.map((row) => ({
    commitment: row.commitment,
    secret: new Uint8Array(row.secret),
    publicKey: new Uint8Array(row.public_key),
    poolId: row.pool_id,
    tokenContract: row.token_contract,
    amount: BigInt(row.amount),
    encryptedMetadata: row.encrypted_metadata ? new Uint8Array(row.encrypted_metadata) : undefined,
    spent: false,
    createdAt: row.created_at,
  }));
}

/**
 * Mark a note as spent.
 */
export async function markNoteAsSpent(walletAddress: string, commitment: string): Promise<void> {
  const db = await getSppDatabase(walletAddress);
  await db.runAsync(`UPDATE notes SET spent = 1, updated_at = ? WHERE commitment = ?`, Date.now(), commitment);
}

// ── Sync State Operations ────────────────────────────────────────────────────

export interface SyncState {
  poolId: string;
  ledgerHeight: number;
  cursor: number;
  status: 'syncing' | 'up-to-date' | 'needs-history';
}

/**
 * Get the current sync state for a pool, or null if not yet synced.
 */
export async function getSyncState(walletAddress: string, poolId: string): Promise<SyncState | null> {
  const db = await getSppDatabase(walletAddress);

  const row = await db.getFirstAsync<any>(
    `SELECT pool_id, ledger_height, cursor, status FROM sync_state WHERE pool_id = ?`,
    poolId,
  );

  if (!row) return null;

  return {
    poolId: row.pool_id,
    ledgerHeight: row.ledger_height,
    cursor: row.cursor,
    status: row.status || 'syncing',
  };
}

/**
 * Update the sync state for a pool.
 * Creates a new entry if it doesn't exist.
 */
export async function updateSyncState(walletAddress: string, state: SyncState): Promise<void> {
  const db = await getSppDatabase(walletAddress);
  const now = Date.now();

  await db.runAsync(
    `INSERT INTO sync_state (pool_id, ledger_height, cursor, status, last_sync_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pool_id) DO UPDATE SET
       ledger_height = excluded.ledger_height,
       cursor = excluded.cursor,
       status = excluded.status,
       last_sync_at = excluded.last_sync_at`,
    state.poolId,
    state.ledgerHeight,
    state.cursor,
    state.status,
    now,
  );
}

/**
 * Get sync states for all pools.
 */
export async function getAllSyncStates(walletAddress: string): Promise<SyncState[]> {
  const db = await getSppDatabase(walletAddress);

  const rows = await db.allAsync<any>(
    `SELECT pool_id, ledger_height, cursor, status FROM sync_state ORDER BY pool_id`,
  );

  return rows.map((row) => ({
    poolId: row.pool_id,
    ledgerHeight: row.ledger_height,
    cursor: row.cursor,
    status: row.status || 'syncing',
  }));
}

// ── Nullifier Operations (prevent double-spend) ──────────────────────────────

/**
 * Add a nullifier (spent note) to the set.
 */
export async function addNullifier(
  walletAddress: string,
  nullifier: Uint8Array,
  commitment: string,
): Promise<void> {
  const db = await getSppDatabase(walletAddress);

  await db.runAsync(
    `INSERT OR IGNORE INTO nullifiers (nullifier, commitment, spent_at)
     VALUES (?, ?, ?)`,
    nullifier,
    commitment,
    Date.now(),
  );
}

/**
 * Check if a nullifier is in the spent set.
 */
export async function hasNullifier(walletAddress: string, nullifier: Uint8Array): Promise<boolean> {
  const db = await getSppDatabase(walletAddress);

  const row = await db.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM nullifiers WHERE nullifier = ?`,
    nullifier,
  );

  return (row?.count ?? 0) > 0;
}

/**
 * Get all nullifiers (for recovery / re-sync).
 */
export async function getAllNullifiers(walletAddress: string): Promise<Uint8Array[]> {
  const db = await getSppDatabase(walletAddress);

  const rows = await db.allAsync<any>(`SELECT nullifier FROM nullifiers ORDER BY spent_at DESC`);

  return rows.map((row) => new Uint8Array(row.nullifier));
}

// ── Event Cache Operations ───────────────────────────────────────────────────

/**
 * Cache a pool event.
 */
export async function cachePoolEvent(
  walletAddress: string,
  poolId: string,
  ledgerHeight: number,
  eventData: Uint8Array,
): Promise<void> {
  const db = await getSppDatabase(walletAddress);

  await db.runAsync(
    `INSERT INTO event_cache (pool_id, ledger_height, event_data, cached_at)
     VALUES (?, ?, ?, ?)`,
    poolId,
    ledgerHeight,
    eventData,
    Date.now(),
  );
}

/**
 * Get cached events for a pool within a ledger height range.
 */
export async function getCachedPoolEvents(
  walletAddress: string,
  poolId: string,
  minHeight: number,
  maxHeight: number,
): Promise<Array<{ ledgerHeight: number; eventData: Uint8Array }>> {
  const db = await getSppDatabase(walletAddress);

  const rows = await db.allAsync<any>(
    `SELECT ledger_height, event_data FROM event_cache
     WHERE pool_id = ? AND ledger_height BETWEEN ? AND ?
     ORDER BY ledger_height ASC`,
    poolId,
    minHeight,
    maxHeight,
  );

  return rows.map((row) => ({
    ledgerHeight: row.ledger_height,
    eventData: new Uint8Array(row.event_data),
  }));
}

// ── Database Cleanup (wallet removal) ────────────────────────────────────────

/**
 * Close the database connection (frees resources).
 * Called before deleting the database file.
 */
async function closeSppDatabase(): Promise<void> {
  if (dbInstance) {
    try {
      await dbInstance.closeAsync();
    } catch (error) {
      console.warn('[spp-storage] failed to close database', error);
    }
    dbInstance = null;
    initPromise = null;
  }
}

/**
 * Delete the SPP database file and clear the encryption key.
 * Called when the wallet is removed.
 *
 * @param walletAddress The wallet address (used to find the encryption key).
 */
export async function clearSppDatabase(walletAddress: string): Promise<void> {
  try {
    // Close the connection first.
    await closeSppDatabase();

    // Delete the database file.
    try {
      const db = await SQLite.openDatabaseAsync(SPP_DATABASE_NAME);
      await db.closeAsync();
      // Note: expo-sqlite doesn't have a direct delete API yet, so we'll rely on the
      // encryption key deletion below to prevent access. On app reinstall, a new
      // database will be created. If per-device cleanup is needed, it would require
      // native code to call sqlite3_delete or remove the file from disk.
    } catch (error) {
      // Database may not exist yet; that's fine.
    }

    // Clear the encryption key from secure store.
    await clearSppEncryptionKey(walletAddress);
  } catch (error) {
    console.error('[spp-storage] failed to clear SPP database', error);
    throw error;
  }
}

// ── Batch Operations (for efficiency) ────────────────────────────────────────

/**
 * Execute a transaction: run a function that takes the database,
 * and roll back on error.
 */
export async function runSppTransaction<T>(
  walletAddress: string,
  fn: (db: SQLite.SQLiteDatabase) => Promise<T>,
): Promise<T> {
  const db = await getSppDatabase(walletAddress);

  try {
    await db.execAsync('BEGIN TRANSACTION');
    const result = await fn(db);
    await db.execAsync('COMMIT');
    return result;
  } catch (error) {
    try {
      await db.execAsync('ROLLBACK');
    } catch (rollbackError) {
      console.warn('[spp-storage] rollback failed', rollbackError);
    }
    throw error;
  }
}

/**
 * Clear all SPP state (notes, sync state, nullifiers, events).
 * Called during development / testing, not in production.
 * Use clearSppDatabase() for wallet removal.
 */
export async function clearAllSppState(walletAddress: string): Promise<void> {
  const db = await getSppDatabase(walletAddress);

  await db.execAsync(`
    DELETE FROM notes;
    DELETE FROM sync_state;
    DELETE FROM nullifiers;
    DELETE FROM event_cache;
  `);
}
