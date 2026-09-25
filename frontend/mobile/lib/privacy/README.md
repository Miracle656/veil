# Stellar Private Payments (SPP) Storage — Mobile

Quick reference for SPP state storage on mobile.

## What This Does

Persists Stellar Private Payments (SPP) state in encrypted SQLite:
- **Notes**: Private commitments and secrets for shielded transactions
- **Sync State**: Ledger bookmarks so sync resumes where it stopped
- **Nullifiers**: Spent notes to prevent re-spending
- **Event Cache**: Pool events for recovery

Encryption: AES-256 via SQLCipher, key stored in OS keychain.

## Quick Start

### Store a Note
```typescript
import * as storage from './storage';

await storage.storeNote(walletAddress, {
  commitment: 'note_commitment_hash',
  secret: new Uint8Array([...]),        // Private note secret
  publicKey: new Uint8Array([...]),     // Ephemeral public key
  poolId: 'pool_contract_id',
  tokenContract: 'token_contract_id',
  amount: BigInt(1000000),              // Amount in drops
  encryptedMetadata: new Uint8Array([...]),  // Optional: encrypted transaction details
});
```

### Get Unspent Notes
```typescript
const notes = await storage.getUnspentNotes(walletAddress, poolId);
// Returns: SppNote[]
// Each note includes: commitment, secret, publicKey, amount, createdAt
```

### Track Sync Progress
```typescript
// Save bookmark
await storage.updateSyncState(walletAddress, {
  poolId: 'pool_1',
  ledgerHeight: 12345,      // Current ledger height
  cursor: 500,              // Event cursor in the pool
  status: 'syncing',        // 'syncing' | 'up-to-date' | 'needs-history'
});

// Retrieve on app restart
const state = await storage.getSyncState(walletAddress, poolId);
if (state) {
  // Resume from state.ledgerHeight, state.cursor
}
```

### Prevent Double-Spend
```typescript
// Add spent note to nullifier set
await storage.addNullifier(walletAddress, nullifierBytes, commitment);

// Check before spending
const isSpent = await storage.hasNullifier(walletAddress, nullifierBytes);
```

### Cache Pool Events
```typescript
// Store event from pool
await storage.cachePoolEvent(walletAddress, poolId, ledgerHeight, eventDataBytes);

// Retrieve for recovery
const events = await storage.getCachedPoolEvents(
  walletAddress,
  poolId,
  minLedgerHeight,
  maxLedgerHeight
);
```

## API Reference

### Core Functions

| Function | Purpose | Returns |
|----------|---------|---------|
| `getSppDatabase(address)` | Open encrypted database | `Promise<SQLiteDatabase>` |
| `getSppEncryptionKey(address)` | Get/create encryption key | `Promise<string>` |
| `clearSppDatabase(address)` | Delete database and key | `Promise<void>` |

### Note Storage

| Function | Purpose | Returns |
|----------|---------|---------|
| `storeNote(address, note)` | Save a note | `Promise<void>` |
| `getUnspentNotes(address, poolId)` | Get notes for pool | `Promise<SppNote[]>` |
| `markNoteAsSpent(address, commitment)` | Mark as spent | `Promise<void>` |

### Sync State

| Function | Purpose | Returns |
|----------|---------|---------|
| `getSyncState(address, poolId)` | Get bookmark | `Promise<SyncState \| null>` |
| `updateSyncState(address, state)` | Save bookmark | `Promise<void>` |
| `getAllSyncStates(address)` | Get all pools | `Promise<SyncState[]>` |

### Nullifiers

| Function | Purpose | Returns |
|----------|---------|---------|
| `addNullifier(address, nullifier, commitment)` | Add to spent set | `Promise<void>` |
| `hasNullifier(address, nullifier)` | Check if spent | `Promise<boolean>` |
| `getAllNullifiers(address)` | Get all spent | `Promise<Uint8Array[]>` |

### Event Cache

| Function | Purpose | Returns |
|----------|---------|---------|
| `cachePoolEvent(address, poolId, height, data)` | Store event | `Promise<void>` |
| `getCachedPoolEvents(address, poolId, min, max)` | Query events | `Promise<Event[]>` |

### Utilities

| Function | Purpose | Returns |
|----------|---------|---------|
| `runSppTransaction(address, fn)` | Atomic operation | `Promise<T>` |
| `clearAllSppState(address)` | Wipe all tables | `Promise<void>` |

## Types

```typescript
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

export interface SyncState {
  poolId: string;
  ledgerHeight: number;
  cursor: number;
  status: 'syncing' | 'up-to-date' | 'needs-history';
}
```

## Database Schema

### notes
Commitments and secrets for shielded transactions.
```sql
commitment          TEXT UNIQUE NOT NULL    -- On-chain commitment hash
secret              BLOB NOT NULL           -- Local note secret
public_key          BLOB NOT NULL           -- Ephemeral public key
pool_id             TEXT NOT NULL           -- Pool contract ID
token_contract      TEXT NOT NULL           -- Token contract ID
amount              BIGINT NOT NULL         -- Amount in drops
encrypted_metadata  BLOB                    -- Transaction details (encrypted)
spent               INTEGER DEFAULT 0       -- 1 if spent
created_at          INTEGER NOT NULL        -- Timestamp (ms)
updated_at          INTEGER NOT NULL        -- Last update (ms)
```

### sync_state
Bookmarks for resuming sync.
```sql
pool_id             TEXT UNIQUE NOT NULL    -- Pool contract ID
ledger_height       INTEGER NOT NULL        -- Last synced ledger
cursor              INTEGER DEFAULT 0       -- Event cursor
status              TEXT DEFAULT 'syncing'  -- Sync status
last_sync_at        INTEGER NOT NULL        -- Timestamp (ms)
```

### nullifiers
Spent notes (prevent re-spending).
```sql
nullifier           BLOB UNIQUE NOT NULL    -- Spent note identifier
commitment          TEXT NOT NULL           -- Associated commitment
spent_at            INTEGER NOT NULL        -- Timestamp (ms)
```

### event_cache
Cached pool events for recovery.
```sql
pool_id             TEXT NOT NULL           -- Pool contract ID
ledger_height       INTEGER NOT NULL        -- Event height
event_data          BLOB NOT NULL           -- Serialized event
cached_at           INTEGER NOT NULL        -- Timestamp (ms)
```

## Security

- **Encryption**: AES-256 via SQLCipher (automatically handled)
- **Key Storage**: iOS Keychain / Android Keystore (via expo-secure-store)
- **Key Generation**: 32 random bytes per wallet
- **Access**: Key required for any database read/write
- **Deletion**: Key deletion makes database unreadable

## Encryption Details

### Key Derivation
1. Per-wallet encryption key in secure store
2. Key name: `veil_spp_db_key_{walletAddress}`
3. Generated on first use, persisted across app restarts
4. Deleted when wallet is removed

### Database Encryption
1. SQLCipher with `PRAGMA key = "x'{hexKey}'"`
2. AES-256 encryption of all pages
3. HMAC authentication of page data
4. Database file is binary blob at `veil_spp_state.db`

### At-Rest Security
- Database file unreadable without key
- Key held in OS keychain only
- No plaintext secrets in AsyncStorage or logs
- Encryption/decryption transparent to caller

## Common Patterns

### Initialize on App Start
```typescript
import * as storage from './privacy/storage';
import { getWalletAddress } from '../walletStore';

export async function initializePrivacyStorage() {
  const address = await getWalletAddress();
  if (!address) return;
  
  // Pre-open database to initialize schema
  await storage.getSppDatabase(address);
  
  // Check sync state for each pool
  const states = await storage.getAllSyncStates(address);
  console.log('Resumed sync from:', states);
}
```

### Resume Sync After App Restart
```typescript
export async function resumeSync(walletAddress: string, poolId: string) {
  const state = await storage.getSyncState(walletAddress, poolId);
  
  if (!state) {
    // First sync from beginning
    return { ledgerHeight: 0, cursor: 0 };
  }
  
  if (state.status === 'needs-history') {
    // Connect to bootnode for full history
    return fetchHistoryFromBootnode(walletAddress, poolId);
  }
  
  // Resume from saved point
  return { ledgerHeight: state.ledgerHeight, cursor: state.cursor };
}
```

### Atomic Batch Operation
```typescript
export async function storeShieldTransaction(
  walletAddress: string,
  poolId: string,
  notes: SppNote[],
  syncUpdate: SyncState
) {
  await storage.runSppTransaction(walletAddress, async (db) => {
    // Store all notes
    for (const note of notes) {
      await storage.storeNote(walletAddress, note);
    }
    
    // Update sync state
    await storage.updateSyncState(walletAddress, syncUpdate);
    
    // All succeed or all fail
  });
}
```

## Testing

```typescript
import * as storage from '../storage';

describe('SPP Storage', () => {
  const address = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  
  it('stores and retrieves a note', async () => {
    const note: storage.SppNote = {
      commitment: 'test_commit',
      secret: new Uint8Array([1, 2, 3]),
      publicKey: new Uint8Array([4, 5, 6]),
      poolId: 'pool_1',
      tokenContract: 'token_1',
      amount: BigInt(1000),
    };
    
    await storage.storeNote(address, note);
    const notes = await storage.getUnspentNotes(address, 'pool_1');
    
    expect(notes).toHaveLength(1);
    expect(notes[0].commitment).toBe('test_commit');
  });
});
```

## Troubleshooting

### Database Not Opening
- Check that wallet address is valid (`C...` Soroban address)
- Verify iOS/Android keychain access is working
- Check device storage is not full

### Encryption Key Not Found
- Key is wallet-specific; different wallet = different key
- If wallet removed and recreated, new key is generated
- Old data becomes unreadable (by design)

### Sync State Not Found
- First sync: `getSyncState()` returns `null` — start from height 0
- Use `updateSyncState()` after each sync batch
- Check that `poolId` parameter matches exactly

### Performance Issues
- Indexes created automatically on first use
- Use `runSppTransaction()` for batches instead of individual writes
- WAL mode enabled for concurrent access

## Related Documentation

- [STORAGE_IMPLEMENTATION.md](./STORAGE_IMPLEMENTATION.md) — Detailed architecture
- [../config.ts](../config.ts) — SPP contract addresses and pool configs
- [../../walletStore.ts](../../walletStore.ts) — Wallet management
- [../../../docs/PRIVACY_THREAT_MODEL.md](../../../docs/PRIVACY_THREAT_MODEL.md) — Security model

## Contributing

When modifying storage.ts:
1. Update STORAGE_IMPLEMENTATION.md with new functions
2. Add unit tests to storage.test.ts
3. Follow existing error handling patterns
4. Never expose encryption keys in logs
5. Use parameterized queries to prevent SQL injection
6. Test on both iOS and Android devices
