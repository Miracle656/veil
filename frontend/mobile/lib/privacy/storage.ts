/**
 * SPP state storage for mobile — SQLite-backed, encrypted at rest.
 *
 * The browser SDK keeps SPP state (notes, sync cursors, nullifier sets) in SQLite
 * on OPFS. Mobile has no OPFS, so we implement the same schema on device SQLite,
 * encrypted with a key held in the secure store. The database survives app
 * restarts (so sync resumes where it stopped and notes persist), but is wiped
 * when the wallet is removed.
 *
 * Database encryption uses SQLCipher (via the expo-sqlite config plugin):
 * - Key: 32 random bytes, held in the OS secure store, never derived from
 *   anything the wallet address or a passkey can reproduce — so losing the
 *   secure-store entry loses the notes. That is deliberate: the alternative is
 *   a key an attacker with the address could recompute.
 * - Cipher: SQLCipher defaults (AES-256-CBC with per-page HMAC).
 * - The secure-store entry is scoped per wallet address, so each wallet (and so
 *   each network) has its own key.
 *
 * SPP itself is an unaudited, testnet-only developer preview: `isPrivacyEnabled`
 * in ./config.ts returns false on mainnet unconditionally. This module only
 * persists state and makes no privacy guarantee of its own beyond encryption at
 * rest — it does not hide anything from an attacker who has the unlocked device.
 *
 * Schema mirrors the upstream SPP SDK:
 * - notes: commitment → secret + metadata
 * - sync state: ledger bookmark, last scanned height
 * - nullifiers: already-spent notes (prevent double-spend)
 * - event cache: scanned pool events for recovery
 */

import { getRandomBytes } from 'expo-crypto';
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
      -- TEXT, not an integer type. SPP amounts are i128 and SQLite's INTEGER
      -- affinity is 64-bit: a decimal string that does not fit i64 is silently
      -- coerced to REAL, which loses low-order digits. Holding the decimal
      -- string keeps the value exact and BigInt(row.amount) reads it back.
      amount TEXT NOT NULL,
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
let dbInstanceAddress: string | null = null;
let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Get or open the SPP database.
 * Opens it once per app instance; subsequent calls return the cached connection.
 * Database is automatically encrypted via SQLCipher when this is the first open.
 *
 * The cache is keyed on the wallet address, because each wallet has its own
 * encryption key: switching network or recreating the wallet changes the address,
 * and handing back the previous wallet's connection would read the wrong notes.
 *
 * @param walletAddress Required to derive the encryption key.
 * @returns The open database connection.
 */
export async function getSppDatabase(walletAddress: string): Promise<SQLite.SQLiteDatabase> {
  // Reuse the cached instance only when it belongs to this wallet.
  if (dbInstance && dbInstanceAddress === walletAddress) return dbInstance;

  // A different wallet is asking: drop the old connection before opening its database.
  if (dbInstance) await closeSppDatabase();

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
      // The key is interpolated into the statement, so a failure here must never
      // surface the driver's error text — it echoes the SQL, key included.
      try {
        await db.execAsync(`PRAGMA key = "x'${encryptionKey}'"`);
      } catch {
        throw new Error('[spp-storage] failed to apply the database encryption key');
      }

      // Verify the key actually decrypts the file. Reading the schema is the
      // cheap canonical SQLCipher check: with a wrong key SQLite cannot parse
      // the header and raises "file is not a database". A full integrity_check
      // would also work but scans the whole file on every cold start.
      try {
        await db.getFirstAsync('SELECT count(*) AS count FROM sqlite_master');
      } catch (error) {
        throw new Error(
          '[spp-storage] the SPP database could not be decrypted with the stored key',
          { cause: error },
        );
      }

      // Initialize schema.
      await initializeSppSchema(db);

      dbInstance = db;
      dbInstanceAddress = walletAddress;
      return db;
    } finally {
      initPromise = null; // Reset so a later attempt re-reads the cache or retries.
    }
  })();

  return initPromise;
}

// ── Note Storage Operations ──────────────────────────────────────────────────

/**
 * Shapes of the rows the queries below select, so the mapping back to the
 * public types is checked rather than cast through `any`. BLOB columns arrive
 * as `Uint8Array` on device; `amount` is the exact decimal string written by
 * {@link storeNote}.
 */
interface NoteRow {
  commitment: string;
  secret: Uint8Array;
  public_key: Uint8Array;
  pool_id: string;
  token_contract: string;
  amount: string;
  encrypted_metadata: Uint8Array | null;
  created_at: number;
}

interface SyncStateRow {
  pool_id: string;
  ledger_height: number;
  cursor: number;
  status: SyncState['status'] | null;
}

interface NullifierRow {
  nullifier: Uint8Array;
}

interface EventCacheRow {
  ledger_height: number;
  event_data: Uint8Array;
}

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

  const rows = await db.getAllAsync<NoteRow>(
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

  const row = await db.getFirstAsync<SyncStateRow>(
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

  const rows = await db.getAllAsync<SyncStateRow>(
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

  const rows = await db.getAllAsync<NullifierRow>(
    `SELECT nullifier FROM nullifiers ORDER BY spent_at DESC`,
  );

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

  const rows = await db.getAllAsync<EventCacheRow>(
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
 * Close the database connection and forget the cached handle.
 *
 * Called before deleting the database file, and whenever the app wants to drop
 * the SQLCipher connection without wiping anything — backgrounding, or a
 * switch to a different wallet. The next getSppDatabase() re-opens it.
 */
export async function closeSppDatabase(): Promise<void> {
  if (dbInstance) {
    try {
      await dbInstance.closeAsync();
    } catch (error) {
      console.warn('[spp-storage] failed to close database', error);
    }
    dbInstance = null;
    dbInstanceAddress = null;
    initPromise = null;
  }
}

/**
 * Delete the SPP database file and clear the encryption key.
 * Called when the wallet is removed.
 *
 * The file itself has to go, not just the key. Leaving it behind would keep the
 * removed wallet's notes and nullifiers on disk, and the next wallet on the
 * device generates a fresh key that cannot open the old ciphertext — so SPP
 * would be permanently unopenable rather than simply empty.
 *
 * @param walletAddress The wallet address (used to find the encryption key).
 */
export async function clearSppDatabase(walletAddress: string): Promise<void> {
  try {
    // Close the connection first; the file cannot be removed while it is open.
    await closeSppDatabase();

    // Delete the database file.
    try {
      await SQLite.deleteDatabaseAsync(SPP_DATABASE_NAME);
    } catch {
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
