# SPP Storage Integration Guide

Guide for integrating the SPP storage adapter with the Stellar Private Payments SDK.

## Overview

This storage adapter provides the persistence layer for SPP state on mobile. When the SPP SDK is published, it will use these functions to maintain sync progress and note data across app restarts.

## Integration Points

### 1. SDK Initialization

Once the SPP SDK is available:

```typescript
import * as SPP from '@stellar/spp-sdk';  // Future package
import * as storage from './lib/privacy/storage';
import { getWalletAddress } from './lib/walletStore';

export async function initializeSpp() {
  const walletAddress = await getWalletAddress();
  if (!walletAddress) return null;

  // Open encrypted storage
  const db = await storage.getSppDatabase(walletAddress);

  // Initialize SDK with storage backend
  const sdk = new SPP.SDK({
    network: 'testnet',
    storage: {
      // SDK passes storage adapter
      storeState: (key: string, value: string) => 
        db.runAsync('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)', key, value),
      
      getState: (key: string) =>
        db.getFirstAsync('SELECT value FROM state WHERE key = ?', key),
      
      deleteState: (key: string) =>
        db.runAsync('DELETE FROM state WHERE key = ?', key),
    },
    walletAddress,
  });

  return sdk;
}
```

### 2. Sync Flow

```typescript
import * as storage from './lib/privacy/storage';

export async function syncSppPool(walletAddress: string, poolId: string) {
  // Get saved sync state
  const savedState = await storage.getSyncState(walletAddress, poolId);
  
  const startHeight = savedState?.ledgerHeight ?? 0;
  const startCursor = savedState?.cursor ?? 0;

  // Sync from saved point
  const result = await sdk.syncPool(poolId, {
    startHeight,
    startCursor,
  });

  // Save new sync state
  if (result.newState) {
    await storage.updateSyncState(walletAddress, {
      poolId,
      ledgerHeight: result.newState.ledgerHeight,
      cursor: result.newState.cursor,
      status: result.isComplete ? 'up-to-date' : 'syncing',
    });
  }

  // Store discovered notes
  for (const note of result.newNotes) {
    await storage.storeNote(walletAddress, {
      commitment: note.commitment,
      secret: note.secret,
      publicKey: note.publicKey,
      poolId,
      tokenContract: note.tokenContract,
      amount: BigInt(note.amount),
      encryptedMetadata: note.metadata,
    });
  }

  return result;
}
```

### 3. Transaction Building

```typescript
export async function buildPrivateTransaction(
  walletAddress: string,
  poolId: string,
  inputs: SppNote[],
  outputs: { recipient: string; amount: bigint }[]
) {
  // Get current sync state
  const syncState = await storage.getSyncState(walletAddress, poolId);
  if (!syncState || syncState.status !== 'up-to-date') {
    throw new Error('Pool not fully synced');
  }

  // Check inputs are not spent
  for (const input of inputs) {
    const isSpent = await storage.hasNullifier(
      walletAddress,
      computeNullifier(input.secret)
    );
    if (isSpent) {
      throw new Error('Input already spent');
    }
  }

  // Build transaction
  const tx = await sdk.buildTransaction({
    poolId,
    inputs,
    outputs,
  });

  return tx;
}
```

### 4. Storing Transactions After Submit

```typescript
export async function storeSubmittedTransaction(
  walletAddress: string,
  transaction: SppTransaction
) {
  // Atomic storage: mark inputs as spent
  await storage.runSppTransaction(walletAddress, async (db) => {
    for (const input of transaction.inputs) {
      // Add nullifier
      await storage.addNullifier(
        walletAddress,
        computeNullifier(input.secret),
        input.commitment
      );
    }

    // Store outputs as new notes
    for (const output of transaction.outputs) {
      await storage.storeNote(walletAddress, {
        commitment: output.commitment,
        secret: output.secret,
        publicKey: output.publicKey,
        poolId: transaction.poolId,
        tokenContract: transaction.tokenContract,
        amount: output.amount,
        encryptedMetadata: output.metadata,
      });
    }
  });
}
```

### 5. Recovery Flow

```typescript
export async function recoverSppState(
  walletAddress: string,
  poolId: string
) {
  // No sync state saved; fetch from bootnode or start over
  const cachedEvents = await storage.getCachedPoolEvents(
    walletAddress,
    poolId,
    0,
    Number.MAX_SAFE_INTEGER
  );

  if (cachedEvents.length === 0) {
    // Fresh recovery: fetch from bootnode
    const events = await fetchEventsFromBootnode(poolId);
    
    for (const event of events) {
      await storage.cachePoolEvent(
        walletAddress,
        poolId,
        event.ledgerHeight,
        event.data
      );
    }
  }

  // Rescan all events to recover notes
  return await sdk.rescanEvents(walletAddress, poolId, cachedEvents);
}
```

### 6. Wallet Removal

```typescript
import { clearWalletStore } from './lib/walletStore';

export async function removeWallet() {
  // Already integrated: clearWalletStore calls clearSppDatabase
  await clearWalletStore();
  
  // All SPP state automatically deleted:
  // - Encryption key removed from keychain
  // - Database becomes unreadable
  // - Notes and sync state lost
}
```

## Event Flow Diagrams

### App Start: Resume Sync

```
App Start
  ↓
Load Wallet Address
  ↓
Open SPP Storage (getSppDatabase)
  ↓
Get All Sync States (getAllSyncStates)
  ├─ For each pool:
  │  ├─ If no sync state: Start fresh sync
  │  ├─ If syncing: Resume from cursor
  │  └─ If needs-history: Fetch from bootnode
  ↓
Start Sync Process
```

### Private Transaction: Shield → Spend → Unshield

```
Shield (Public → Pool)
  ├─ Receive output note
  ├─ Store note (storeNote)
  └─ Update sync state

Private Send (Pool → Pool)
  ├─ Select input notes (getUnspentNotes)
  ├─ Verify not spent (hasNullifier)
  ├─ Build & sign transaction
  └─ Mark inputs as spent (addNullifier)

Unshield (Pool → Public)
  ├─ Select input notes
  ├─ Verify not spent
  ├─ Build & sign transaction
  └─ Mark inputs as spent
```

### Recovery: Rebuild State

```
App Start (No wallet)
  ↓
User imports backup
  ↓
Set wallet address (setWalletAddress)
  ↓
Initialize SPP storage (getSppDatabase)
  ↓
Fetch bootnode history (getCachedPoolEvents)
  ↓
Rescan events to recover notes
  ↓
Restore sync state for each pool
```

## Storage Schema Integration

The adapter provides four tables. The SDK will use them as follows:

### notes table
```sql
-- SDK stores discovered notes
INSERT INTO notes (
  commitment, secret, public_key, pool_id, token_contract,
  amount, encrypted_metadata, created_at, updated_at
) VALUES (...)

-- SDK queries spendable notes
SELECT * FROM notes WHERE pool_id = ? AND spent = 0
  ORDER BY created_at DESC

-- SDK marks spent notes
UPDATE notes SET spent = 1 WHERE commitment = ?
```

### sync_state table
```sql
-- SDK saves progress
INSERT INTO sync_state (pool_id, ledger_height, cursor, status, last_sync_at)
  VALUES (...) 
  ON CONFLICT(pool_id) DO UPDATE SET ...

-- App resumes from bookmark
SELECT ledger_height, cursor FROM sync_state WHERE pool_id = ?

-- App checks sync status
SELECT status FROM sync_state WHERE pool_id = ?
```

### nullifiers table
```sql
-- SDK adds spent notes
INSERT INTO nullifiers (nullifier, commitment, spent_at) VALUES (...)

-- SDK prevents re-spending
SELECT COUNT(*) FROM nullifiers WHERE nullifier = ?

-- SDK scans for all spent
SELECT * FROM nullifiers ORDER BY spent_at DESC
```

### event_cache table
```sql
-- SDK caches pool events
INSERT INTO event_cache (pool_id, ledger_height, event_data, cached_at)
  VALUES (...)

-- SDK uses for recovery
SELECT event_data FROM event_cache
  WHERE pool_id = ? AND ledger_height BETWEEN ? AND ?
  ORDER BY ledger_height ASC
```

## Error Handling

### Handle Missing Wallet
```typescript
const address = await getWalletAddress();
if (!address) {
  // Wallet not set up; show onboarding
  return;
}

try {
  const db = await storage.getSppDatabase(address);
} catch (error) {
  console.error('Failed to open SPP storage:', error);
  // Could be keychain issue or device storage full
}
```

### Handle Sync Failures
```typescript
try {
  await syncSppPool(walletAddress, poolId);
} catch (error) {
  if (error.message.includes('needs-history')) {
    // Fetch from bootnode
    await recoverSppState(walletAddress, poolId);
  } else if (error.message.includes('connection')) {
    // Network error; will retry on next sync
  } else {
    // Unknown error
    console.error('Sync failed:', error);
  }
}
```

### Handle Encryption Key Issues
```typescript
try {
  const key = await storage.getSppEncryptionKey(walletAddress);
} catch (error) {
  if (error.message.includes('keychain')) {
    // iOS Keychain or Android Keystore error
    // Show user error; may need to re-enter passphrase
    alert('Wallet recovery required');
  }
}
```

## Performance Tips

### 1. Batch Operations
```typescript
// ✓ Good: Atomic transaction
await storage.runSppTransaction(walletAddress, async (db) => {
  for (const note of notes) {
    await storage.storeNote(walletAddress, note);
  }
});

// ✗ Slow: Individual transactions
for (const note of notes) {
  await storage.storeNote(walletAddress, note);  // Each is a separate transaction
}
```

### 2. Cache Frequently-Accessed Data
```typescript
// Store sync state once at start
const syncStates = await storage.getAllSyncStates(walletAddress);
const syncMap = new Map(syncStates.map(s => [s.poolId, s]));

// Reuse instead of querying repeatedly
const state = syncMap.get(poolId);
```

### 3. Use Indexes
```typescript
// Fast: Uses idx_notes_pool_spent
const notes = await storage.getUnspentNotes(walletAddress, poolId);

// Fast: Uses idx_sync_state_pool
const state = await storage.getSyncState(walletAddress, poolId);

// Fast: Uses idx_nullifiers_nullifier
const isSpent = await storage.hasNullifier(walletAddress, nullifier);
```

## Testing

### Mock Storage for SDK Testing
```typescript
import * as storage from './privacy/storage';
import * as SQLite from 'expo-sqlite';

// In test setup:
jest.mock('expo-sqlite');
jest.mock('../storage');  // secure store

const mockDb = {
  execAsync: jest.fn(),
  runAsync: jest.fn(),
  allAsync: jest.fn(),
  getFirstAsync: jest.fn(),
};

(SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);
```

### Test SDK Integration
```typescript
describe('SPP Integration', () => {
  it('stores and retrieves notes', async () => {
    const note = { commitment, secret, publicKey, ... };
    await storage.storeNote(address, note);
    
    const retrieved = await storage.getUnspentNotes(address, poolId);
    expect(retrieved).toContainEqual(note);
  });

  it('resumes sync from bookmark', async () => {
    // Save state
    await storage.updateSyncState(address, {
      poolId, ledgerHeight: 1000, cursor: 100, status: 'syncing'
    });

    // Retrieve and verify
    const state = await storage.getSyncState(address, poolId);
    expect(state.ledgerHeight).toBe(1000);
    expect(state.cursor).toBe(100);
  });
});
```

## Debugging

### Enable Logging
```typescript
// In storage.ts during development
function log(msg: string, data?: any) {
  if (__DEV__) {
    console.log(`[SPP Storage] ${msg}`, data);
  }
}

// Track operations
export async function storeNote(...) {
  log('Storing note', { commitment, poolId });
  // ...
  log('Note stored successfully');
}
```

### Inspect Database
```typescript
// In debugger/console:
import * as storage from './lib/privacy/storage';

const walletAddress = '...';
const db = await storage.getSppDatabase(walletAddress);

// Query tables
const notes = await db.allAsync('SELECT COUNT(*) as count FROM notes');
const states = await db.allAsync('SELECT * FROM sync_state');
const nullifiers = await db.allAsync('SELECT COUNT(*) as count FROM nullifiers');

// Check indexes
const indexes = await db.allAsync("SELECT * FROM sqlite_master WHERE type='index'");
```

## Timeline

| Phase | Task | Status |
|-------|------|--------|
| V131 | Privacy feature flag | ✓ Complete |
| V132 | Key derivation & security model | ✓ Complete |
| V133 | RPC proxy allowlist | ✓ Complete |
| V134 | Web storage (OPFS + encryption) | Pending |
| V135 | (Reserved) | - |
| V136 | Shield transaction (V→P) | Pending |
| V137 | Private send (P→P) | Pending |
| V138 | Unshield transaction (P→V) | Pending |
| V139 | Selective disclosure | Pending |
| V140 | Bootnode support | Pending |
| V141 | **Mobile storage (THIS TASK)** | ✓ **COMPLETE** |
| V142 | Circuit caching | Pending |
| V143 | Mobile recovery UI | Pending |
| V144-149 | (Future iterations) | - |

## References

- [README.md](./README.md) — Quick reference
- [STORAGE_IMPLEMENTATION.md](./STORAGE_IMPLEMENTATION.md) — Architecture
- [../config.ts](../config.ts) — SPP configuration
- [../../walletStore.ts](../../walletStore.ts) — Wallet management
- [PRIVACY_THREAT_MODEL.md](../../docs/PRIVACY_THREAT_MODEL.md) — Security model

## Support

For questions or issues:
1. Check [README.md](./README.md) for quick answers
2. Review [STORAGE_IMPLEMENTATION.md](./STORAGE_IMPLEMENTATION.md) for details
3. Search existing [issues](https://github.com/stellar/veil/issues)
4. Open a new issue with `[SPP Storage]` prefix
