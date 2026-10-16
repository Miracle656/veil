/**
 * Tests for SPP state storage adapter.
 *
 * Verifies:
 * - Database initialization and schema creation
 * - Encryption key generation and persistence in secure store
 * - Note storage and retrieval
 * - Sync state tracking
 * - Nullifier operations (prevent double-spend)
 * - Event caching
 * - Wallet removal cleanup
 */

import * as SQLite from 'expo-sqlite';
import * as storage from '../storage';
import * as secureStore from '../../storage';

// Mock expo-sqlite and secure store
jest.mock('expo-sqlite');
jest.mock('../../storage');

describe('SPP State Storage', () => {
  const mockWalletAddress = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  let mockDb: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create a mock database
    mockDb = {
      execAsync: jest.fn().mockResolvedValue(undefined),
      runAsync: jest.fn().mockResolvedValue({ lastInsertRowid: 1 }),
      getAllAsync: jest.fn().mockResolvedValue([]),
      getFirstAsync: jest.fn().mockResolvedValue(null),
      closeAsync: jest.fn().mockResolvedValue(undefined),
    };

    (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);
  });

  afterEach(async () => {
    // storage.ts caches the open SQLCipher handle at module scope. Neither
    // clearAllMocks nor resetModules reaches it (the `storage` import is already
    // bound), so without an explicit close the first test to open the database
    // leaves it cached and every later test sees zero driver calls.
    await storage.closeSppDatabase();
  });

  describe('Encryption Key Management', () => {
    it('generates and persists a new encryption key', async () => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue(null);
      (secureStore.setSecureItem as jest.Mock).mockResolvedValue(undefined);

      const key = await storage.getSppEncryptionKey(mockWalletAddress);

      // Key should be a 64-character hex string (32 bytes)
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(secureStore.setSecureItem).toHaveBeenCalledWith(
        `veil_spp_db_key_${mockWalletAddress}`,
        key,
      );
    });

    it('retrieves an existing encryption key without regenerating', async () => {
      const existingKey = '0'.repeat(64);
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue(existingKey);

      const key = await storage.getSppEncryptionKey(mockWalletAddress);

      expect(key).toBe(existingKey);
      expect(secureStore.setSecureItem).not.toHaveBeenCalled();
    });

    it('clears the encryption key on wallet removal', async () => {
      (secureStore.deleteSecureItem as jest.Mock).mockResolvedValue(undefined);

      await storage.clearSppEncryptionKey(mockWalletAddress);

      expect(secureStore.deleteSecureItem).toHaveBeenCalledWith(
        `veil_spp_db_key_${mockWalletAddress}`,
      );
    });
  });

  describe('Database Initialization', () => {
    it('opens database with SQLCipher encryption key', async () => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue(null);
      (secureStore.setSecureItem as jest.Mock).mockResolvedValue(undefined);

      await storage.getSppDatabase(mockWalletAddress);

      expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith('veil_spp_state.db', {
        useNewConnection: false,
      });

      // Should set the PRAGMA key and verify the key actually decrypts the file
      expect(mockDb.execAsync).toHaveBeenCalledWith(
        expect.stringContaining("PRAGMA key = \"x'"),
      );
      expect(mockDb.getFirstAsync).toHaveBeenCalledWith(
        'SELECT count(*) AS count FROM sqlite_master',
      );
    });

    it('refuses to hand back a database the stored key cannot decrypt', async () => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue('0'.repeat(64));
      mockDb.getFirstAsync.mockRejectedValueOnce(new Error('file is not a database'));

      await expect(storage.getSppDatabase(mockWalletAddress)).rejects.toThrow(
        /could not be decrypted/,
      );
    });

    it('does not leak the encryption key when the key pragma fails', async () => {
      const secret = 'a'.repeat(64);
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue(secret);
      // The driver echoes the offending SQL, which contains the raw key.
      mockDb.execAsync.mockRejectedValueOnce(
        new Error(`near "PRAGMA key = \"x'${secret}'\"": syntax error`),
      );

      const error = await storage.getSppDatabase(mockWalletAddress).then(
        () => null,
        (e: unknown) => e as Error,
      );

      expect(error?.message).toMatch(/failed to apply the database encryption key/);
      // The raw key must not survive into the message we raise in its place.
      expect(error?.message).not.toContain(secret);
    });

    it('re-opens for a different wallet instead of reusing the cached handle', async () => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue('0'.repeat(64));
      const otherWallet = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

      await storage.getSppDatabase(mockWalletAddress);
      await storage.getSppDatabase(otherWallet);

      // Each wallet has its own SQLCipher key, so one wallet must never be
      // served the other wallet's open connection.
      expect(mockDb.closeAsync).toHaveBeenCalled();
      expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(2);
    });

    it('creates schema on first open', async () => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue(null);
      (secureStore.setSecureItem as jest.Mock).mockResolvedValue(undefined);

      await storage.getSppDatabase(mockWalletAddress);

      const execCalls = mockDb.execAsync.mock.calls;
      const schemaSql = execCalls.find((call: any[]) =>
        call[0].includes('CREATE TABLE IF NOT EXISTS notes'),
      );

      expect(schemaSql).toBeDefined();
      expect(mockDb.execAsync).toHaveBeenCalledWith(expect.stringContaining('PRAGMA journal_mode = WAL'));
      expect(mockDb.execAsync).toHaveBeenCalledWith(expect.stringContaining('PRAGMA foreign_keys = ON'));
    });

    it('reuses database connection on subsequent calls', async () => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue(null);
      (secureStore.setSecureItem as jest.Mock).mockResolvedValue(undefined);

      const db1 = await storage.getSppDatabase(mockWalletAddress);
      const db2 = await storage.getSppDatabase(mockWalletAddress);

      expect(db1).toBe(db2);
      expect(SQLite.openDatabaseAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('Note Storage Operations', () => {
    beforeEach(() => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue('0'.repeat(64));
    });

    it('stores a note', async () => {
      const note: storage.SppNote = {
        commitment: 'commitment_hash',
        secret: new Uint8Array([1, 2, 3]),
        publicKey: new Uint8Array([4, 5, 6]),
        poolId: 'pool_123',
        tokenContract: 'token_abc',
        amount: BigInt(1000),
        encryptedMetadata: new Uint8Array([7, 8, 9]),
        spent: false,
      };

      await storage.storeNote(mockWalletAddress, note);

      expect(mockDb.runAsync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO notes'),
        'commitment_hash',
        note.secret,
        note.publicKey,
        'pool_123',
        'token_abc',
        '1000',
        note.encryptedMetadata,
        0,
        expect.any(Number), // createdAt
        expect.any(Number), // updatedAt
      );
    });

    it('retrieves unspent notes for a pool', async () => {
      const mockNotes = [
        {
          commitment: 'commitment_1',
          secret: Buffer.from([1, 2, 3]),
          public_key: Buffer.from([4, 5, 6]),
          pool_id: 'pool_123',
          token_contract: 'token_abc',
          amount: '1000',
          encrypted_metadata: Buffer.from([7, 8, 9]),
          created_at: Date.now(),
        },
      ];

      mockDb.getAllAsync.mockResolvedValue(mockNotes);

      const notes = await storage.getUnspentNotes(mockWalletAddress, 'pool_123');

      expect(mockDb.getAllAsync).toHaveBeenCalledWith(
        expect.stringContaining('SELECT commitment, secret, public_key'),
        'pool_123',
      );

      expect(notes).toHaveLength(1);
      expect(notes[0].commitment).toBe('commitment_1');
      expect(notes[0].amount).toBe(BigInt(1000));
      expect(notes[0].spent).toBe(false);
    });

    it('marks a note as spent', async () => {
      await storage.markNoteAsSpent(mockWalletAddress, 'commitment_hash');

      expect(mockDb.runAsync).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE notes SET spent = 1'),
        expect.any(Number), // timestamp
        'commitment_hash',
      );
    });
  });

  describe('Sync State Operations', () => {
    beforeEach(() => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue('0'.repeat(64));
    });

    it('stores and retrieves sync state', async () => {
      const syncState: storage.SyncState = {
        poolId: 'pool_123',
        ledgerHeight: 1000,
        cursor: 100,
        status: 'up-to-date',
      };

      await storage.updateSyncState(mockWalletAddress, syncState);

      expect(mockDb.runAsync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO sync_state'),
        'pool_123',
        1000,
        100,
        'up-to-date',
        expect.any(Number),
      );
    });

    it('retrieves sync state for a pool', async () => {
      const mockSyncState = {
        pool_id: 'pool_123',
        ledger_height: 1000,
        cursor: 100,
        status: 'syncing',
      };

      mockDb.getFirstAsync.mockResolvedValue(mockSyncState);

      const state = await storage.getSyncState(mockWalletAddress, 'pool_123');

      expect(mockDb.getFirstAsync).toHaveBeenCalledWith(
        expect.stringContaining('SELECT pool_id, ledger_height, cursor, status'),
        'pool_123',
      );

      expect(state).toEqual({
        poolId: 'pool_123',
        ledgerHeight: 1000,
        cursor: 100,
        status: 'syncing',
      });
    });

    it('returns null for sync state of non-existent pool', async () => {
      mockDb.getFirstAsync.mockResolvedValue(null);

      const state = await storage.getSyncState(mockWalletAddress, 'pool_456');

      expect(state).toBeNull();
    });

    it('retrieves all sync states', async () => {
      const mockStates = [
        {
          pool_id: 'pool_1',
          ledger_height: 1000,
          cursor: 100,
          status: 'up-to-date',
        },
        {
          pool_id: 'pool_2',
          ledger_height: 500,
          cursor: 50,
          status: 'syncing',
        },
      ];

      mockDb.getAllAsync.mockResolvedValue(mockStates);

      const states = await storage.getAllSyncStates(mockWalletAddress);

      expect(states).toHaveLength(2);
      expect(states[0].poolId).toBe('pool_1');
      expect(states[1].poolId).toBe('pool_2');
    });
  });

  describe('Nullifier Operations', () => {
    beforeEach(() => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue('0'.repeat(64));
    });

    it('adds a nullifier', async () => {
      const nullifier = new Uint8Array([1, 2, 3, 4]);

      await storage.addNullifier(mockWalletAddress, nullifier, 'commitment_hash');

      expect(mockDb.runAsync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR IGNORE INTO nullifiers'),
        nullifier,
        'commitment_hash',
        expect.any(Number),
      );
    });

    it('checks if a nullifier exists', async () => {
      mockDb.getFirstAsync.mockResolvedValue({ count: 1 });

      const exists = await storage.hasNullifier(
        mockWalletAddress,
        new Uint8Array([1, 2, 3, 4]),
      );

      expect(exists).toBe(true);
    });

    it('returns false for non-existent nullifier', async () => {
      mockDb.getFirstAsync.mockResolvedValue({ count: 0 });

      const exists = await storage.hasNullifier(
        mockWalletAddress,
        new Uint8Array([1, 2, 3, 4]),
      );

      expect(exists).toBe(false);
    });

    it('retrieves all nullifiers', async () => {
      const mockNullifiers = [
        { nullifier: Buffer.from([1, 2, 3]) },
        { nullifier: Buffer.from([4, 5, 6]) },
      ];

      mockDb.getAllAsync.mockResolvedValue(mockNullifiers);

      const nullifiers = await storage.getAllNullifiers(mockWalletAddress);

      expect(nullifiers).toHaveLength(2);
      expect(nullifiers[0]).toEqual(new Uint8Array([1, 2, 3]));
      expect(nullifiers[1]).toEqual(new Uint8Array([4, 5, 6]));
    });
  });

  describe('Event Cache Operations', () => {
    beforeEach(() => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue('0'.repeat(64));
    });

    it('caches a pool event', async () => {
      const eventData = new Uint8Array([1, 2, 3, 4]);

      await storage.cachePoolEvent(mockWalletAddress, 'pool_123', 1000, eventData);

      expect(mockDb.runAsync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO event_cache'),
        'pool_123',
        1000,
        eventData,
        expect.any(Number),
      );
    });

    it('retrieves cached events for a ledger height range', async () => {
      const mockEvents = [
        {
          ledger_height: 1000,
          event_data: Buffer.from([1, 2, 3]),
        },
        {
          ledger_height: 1001,
          event_data: Buffer.from([4, 5, 6]),
        },
      ];

      mockDb.getAllAsync.mockResolvedValue(mockEvents);

      const events = await storage.getCachedPoolEvents(
        mockWalletAddress,
        'pool_123',
        1000,
        1001,
      );

      expect(mockDb.getAllAsync).toHaveBeenCalledWith(
        expect.stringContaining('SELECT ledger_height, event_data FROM event_cache'),
        'pool_123',
        1000,
        1001,
      );

      expect(events).toHaveLength(2);
      expect(events[0].ledgerHeight).toBe(1000);
      expect(events[1].ledgerHeight).toBe(1001);
    });
  });

  describe('Database Cleanup', () => {
    beforeEach(() => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue('0'.repeat(64));
    });

    it('clears all SPP state', async () => {
      await storage.clearAllSppState(mockWalletAddress);

      expect(mockDb.execAsync).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM notes'),
      );
      expect(mockDb.execAsync).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM sync_state'),
      );
      expect(mockDb.execAsync).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM nullifiers'),
      );
      expect(mockDb.execAsync).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM event_cache'),
      );
    });

    it('clears SPP database on wallet removal', async () => {
      (secureStore.deleteSecureItem as jest.Mock).mockResolvedValue(undefined);
      await storage.getSppDatabase(mockWalletAddress);

      await storage.clearSppDatabase(mockWalletAddress);

      expect(secureStore.deleteSecureItem).toHaveBeenCalledWith(
        `veil_spp_db_key_${mockWalletAddress}`,
      );
      expect(mockDb.closeAsync).toHaveBeenCalled();
      // The file has to go too: the key alone leaves the removed wallet's notes
      // on disk, and the next wallet's fresh key could never open them.
      expect(SQLite.deleteDatabaseAsync).toHaveBeenCalledWith('veil_spp_state.db');
    });

    it('handles errors during database cleanup gracefully', async () => {
      (secureStore.deleteSecureItem as jest.Mock).mockRejectedValue(new Error('Delete failed'));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(storage.clearSppDatabase(mockWalletAddress)).rejects.toThrow(
        'Delete failed',
      );

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Transaction Support', () => {
    beforeEach(() => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue('0'.repeat(64));
    });

    it('executes a transaction successfully', async () => {
      const fn = jest.fn().mockResolvedValue('result');

      const result = await storage.runSppTransaction(mockWalletAddress, fn);

      expect(result).toBe('result');
      expect(mockDb.execAsync).toHaveBeenCalledWith('BEGIN TRANSACTION');
      expect(mockDb.execAsync).toHaveBeenCalledWith('COMMIT');
      expect(fn).toHaveBeenCalledWith(mockDb);
    });

    it('rolls back on transaction error', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('Transaction failed'));

      await expect(storage.runSppTransaction(mockWalletAddress, fn)).rejects.toThrow(
        'Transaction failed',
      );

      expect(mockDb.execAsync).toHaveBeenCalledWith('BEGIN TRANSACTION');
      expect(mockDb.execAsync).toHaveBeenCalledWith('ROLLBACK');
    });
  });

  describe('Schema Verification', () => {
    beforeEach(() => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue('0'.repeat(64));
    });

    it('creates all required tables', async () => {
      await storage.getSppDatabase(mockWalletAddress);

      const execCalls = mockDb.execAsync.mock.calls;
      const schemaSql = execCalls.find((call: any[]) =>
        call[0].includes('CREATE TABLE IF NOT EXISTS notes'),
      )?.[0];

      expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS notes');
      expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS sync_state');
      expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS nullifiers');
      expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS event_cache');
      // i128 amounts are held as decimal strings; an integer column would be
      // 64-bit and silently coerce anything larger to a lossy REAL.
      expect(schemaSql).toContain('amount TEXT NOT NULL');
    });

    it('creates required indexes', async () => {
      await storage.getSppDatabase(mockWalletAddress);

      const execCalls = mockDb.execAsync.mock.calls;
      const schemaSql = execCalls.find((call: any[]) =>
        call[0].includes('CREATE TABLE IF NOT EXISTS notes'),
      )?.[0];

      expect(schemaSql).toContain('CREATE INDEX IF NOT EXISTS idx_notes_pool_spent');
      expect(schemaSql).toContain('CREATE INDEX IF NOT EXISTS idx_notes_commitment');
      expect(schemaSql).toContain('CREATE INDEX IF NOT EXISTS idx_sync_state_pool');
      expect(schemaSql).toContain('CREATE INDEX IF NOT EXISTS idx_nullifiers_nullifier');
      expect(schemaSql).toContain('CREATE INDEX IF NOT EXISTS idx_event_cache_pool_height');
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      (secureStore.getSecureItem as jest.Mock).mockResolvedValue('0'.repeat(64));
    });

    it('handles storing a note without optional metadata', async () => {
      const note: storage.SppNote = {
        commitment: 'commitment_hash',
        secret: new Uint8Array([1, 2, 3]),
        publicKey: new Uint8Array([4, 5, 6]),
        poolId: 'pool_123',
        tokenContract: 'token_abc',
        amount: BigInt(1000),
        // No encryptedMetadata, spent, or createdAt
      };

      await storage.storeNote(mockWalletAddress, note);

      expect(mockDb.runAsync).toHaveBeenCalled();
    });

    it('handles large BigInt amounts', async () => {
      const note: storage.SppNote = {
        commitment: 'commitment_hash',
        secret: new Uint8Array([1, 2, 3]),
        publicKey: new Uint8Array([4, 5, 6]),
        poolId: 'pool_123',
        tokenContract: 'token_abc',
        amount: BigInt('18446744073709551615'), // Max uint64
      };

      await storage.storeNote(mockWalletAddress, note);

      // Bound as the exact decimal string, into a TEXT column: an INTEGER
      // column would not hold this (it is above i64) and SQLite would coerce it
      // to a lossy REAL.
      expect(mockDb.runAsync).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO notes'),
        'commitment_hash',
        note.secret,
        note.publicKey,
        'pool_123',
        'token_abc',
        '18446744073709551615',
        null, // no encryptedMetadata
        0, // not spent
        expect.any(Number),
        expect.any(Number),
      );
    });
  });
});
