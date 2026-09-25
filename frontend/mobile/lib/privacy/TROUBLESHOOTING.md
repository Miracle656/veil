# SPP Storage Troubleshooting Guide

Common issues and solutions for the SPP mobile storage adapter.

## Build Issues

### Issue: "expo-sqlite not found" during build

**Symptoms**:
```
ERROR: Cannot find module 'expo-sqlite'
ERROR: expo-sqlite is not in package.json
```

**Solutions**:
1. Run npm install in frontend/mobile directory
   ```bash
   cd frontend/mobile
   npm install
   ```

2. Verify expo-sqlite is in package.json
   ```bash
   grep "expo-sqlite" package.json
   # Should show: "expo-sqlite": "~57.0.0"
   ```

3. Clear npm cache and reinstall
   ```bash
   npm cache clean --force
   npm install
   ```

### Issue: SQLCipher plugin not recognized

**Symptoms**:
```
ERROR: useSQLCipher not recognized
ERROR: SQLite plugin configuration invalid
```

**Solutions**:
1. Verify app.config.ts has correct plugin configuration
   ```typescript
   [
     'expo-sqlite',
     {
       useSQLCipher: true,
     },
   ]
   ```

2. For Android: Clear gradle cache
   ```bash
   cd android
   ./gradlew clean
   cd ..
   ```

3. For iOS: Clear Xcode build cache
   ```bash
   rm -rf ~/Library/Developer/Xcode/DerivedData/*
   ```

4. Rebuild from scratch
   ```bash
   npx expo prebuild --clean
   ```

### Issue: Native module compilation fails

**Symptoms**:
```
ERROR: Failed to compile native modules
ERROR: SQLCipher compilation error
```

**Solutions**:
1. For Android: Ensure NDK is installed
   ```bash
   sdkmanager "ndk;25.1.8937393"
   ```

2. For iOS: Ensure CocoaPods dependencies are updated
   ```bash
   cd ios
   pod install --repo-update
   cd ..
   ```

3. Update Expo CLI
   ```bash
   npm install -g expo-cli@latest
   ```

## Runtime Issues

### Issue: Database fails to open

**Symptoms**:
```
ERROR: [spp-storage] failed to open database
Database connection timeout
Cannot initialize database
```

**Solutions**:
1. Check if wallet address is valid
   ```typescript
   const address = await getWalletAddress();
   console.log('Wallet address:', address);  // Should be C... address
   ```

2. Verify device storage is not full
   ```bash
   # iOS
   Settings → General → iPhone Storage → Available
   
   # Android
   Settings → Storage → Available Storage
   ```

3. Check keychain/keystore access
   ```typescript
   const key = await getSppEncryptionKey(walletAddress);
   console.log('Encryption key available:', !!key);
   ```

4. Try clearing app data (will delete SPP state)
   ```bash
   # iOS
   Settings → General → iPhone Storage → [App] → Offload App
   
   # Android
   Settings → Apps → [App] → Storage → Clear Cache
   ```

### Issue: Encryption key not found

**Symptoms**:
```
ERROR: [spp-storage] failed to read from keychain
Keychain access denied
Encryption key missing
```

**Solutions**:
1. For iOS: Ensure app has keychain entitlements
   - Check Xcode project settings
   - Verify "Keychain Sharing" capability is enabled

2. For Android: Ensure device has keystore support
   ```typescript
   const key = await getSppEncryptionKey(walletAddress);
   if (!key) {
    console.error('Keystore not available');
   }
   ```

3. Check device security settings
   ```bash
   # iOS
   Settings → Face ID & Passcode → Keychain
   
   # Android
   Settings → Security → Device Unlock → (must have PIN/biometric)
   ```

4. Try re-creating the key
   ```typescript
   await clearSppEncryptionKey(walletAddress);
   const newKey = await getSppEncryptionKey(walletAddress);
   ```

### Issue: Database file corrupted

**Symptoms**:
```
ERROR: database disk image is malformed
ERROR: database is locked
ERROR: bad sql
```

**Solutions**:
1. Check database integrity
   ```typescript
   try {
     await db.execAsync('PRAGMA integrity_check');
   } catch (error) {
     console.error('Database corrupted:', error);
   }
   ```

2. Clear all SPP state
   ```typescript
   await clearAllSppState(walletAddress);
   ```

3. If that fails, remove wallet and recreate
   ```typescript
   await clearWalletStore();
   // User must create new wallet
   ```

## Data Issues

### Issue: Notes not persisting across restarts

**Symptoms**:
- Store a note
- Force close app
- Restart app
- Note is gone
- No error in logs

**Solutions**:
1. Verify note was actually stored
   ```typescript
   await storeNote(walletAddress, testNote);
   const stored = await getUnspentNotes(walletAddress, testNote.poolId);
   console.log('Note stored:', stored.length > 0);
   ```

2. Check database connection is cached
   ```typescript
   // Should not see "database initialization" log twice
   const db1 = await getSppDatabase(walletAddress);
   const db2 = await getSppDatabase(walletAddress);
   console.log('Same instance:', db1 === db2);  // Should be true
   ```

3. Verify encryption key persists
   ```typescript
   const key1 = await getSppEncryptionKey(walletAddress);
   // App restart
   const key2 = await getSppEncryptionKey(walletAddress);
   console.log('Same key:', key1 === key2);  // Should be true
   ```

### Issue: Sync state not resuming

**Symptoms**:
- Store sync state
- App restarts
- getSyncState returns null
- Sync always starts from beginning

**Solutions**:
1. Verify sync state was stored
   ```typescript
   await updateSyncState(walletAddress, {
     poolId: 'pool_1',
     ledgerHeight: 1000,
     cursor: 100,
     status: 'up-to-date',
   });
   
   const state = await getSyncState(walletAddress, 'pool_1');
   console.log('Sync state stored:', state?.ledgerHeight === 1000);
   ```

2. Check poolId matches exactly
   ```typescript
   const stored = await updateSyncState(walletAddress, {
     poolId: 'POOL_ABC123...',  // Full contract ID
     ...
   });
   
   const retrieved = await getSyncState(walletAddress, 'POOL_ABC123...');  // Same ID
   ```

3. Verify database transactions are atomic
   ```typescript
   await runSppTransaction(walletAddress, async (db) => {
     await updateSyncState(walletAddress, state);
     // All or nothing
   });
   ```

### Issue: Nullifiers not preventing double-spend

**Symptoms**:
- Add nullifier for spent note
- Check with hasNullifier
- Returns false
- Can spend the same note twice

**Solutions**:
1. Verify nullifier format
   ```typescript
   const nullifier = new Uint8Array([1, 2, 3, ...]);  // Must be exact format
   await addNullifier(walletAddress, nullifier, commitment);
   ```

2. Check nullifier is binary
   ```typescript
   // Wrong: string representation
   await addNullifier(walletAddress, "abc123", commitment);
   
   // Right: Uint8Array
   await addNullifier(walletAddress, new Uint8Array([...]), commitment);
   ```

3. Verify hasNullifier is checking same format
   ```typescript
   const same = nullifier1.every((v, i) => v === nullifier2[i]);
   const exists = await hasNullifier(walletAddress, nullifier1);
   ```

## Performance Issues

### Issue: Slow database operations

**Symptoms**:
```
Database operations take > 100ms
App feels laggy when storing notes
Large batches (100+ notes) very slow
```

**Solutions**:
1. Use transactions for batch operations
   ```typescript
   // Slow
   for (const note of notes) {
     await storeNote(walletAddress, note);  // Each is separate
   }
   
   // Fast
   await runSppTransaction(walletAddress, async (db) => {
     for (const note of notes) {
       await storeNote(walletAddress, note);  // Atomic
     }
   });
   ```

2. Verify indexes are being used
   ```typescript
   const indexInfo = await db.allAsync("SELECT * FROM sqlite_master WHERE type='index'");
   console.log('Indexes:', indexInfo.length);  // Should be 5
   ```

3. Check for N+1 queries
   ```typescript
   // Wrong: query in loop
   for (const pool of pools) {
     const state = await getSyncState(walletAddress, pool.id);  // N queries
   }
   
   // Right: single query
   const states = await getAllSyncStates(walletAddress);  // 1 query
   ```

### Issue: High memory usage

**Symptoms**:
```
App crashes with out-of-memory
Memory usage increases with sync
Database operations consume lots of memory
```

**Solutions**:
1. Limit batch sizes
   ```typescript
   // Process in chunks
   const CHUNK_SIZE = 50;
   for (let i = 0; i < notes.length; i += CHUNK_SIZE) {
     const chunk = notes.slice(i, i + CHUNK_SIZE);
     await processBatch(chunk);  // Process smaller chunks
   }
   ```

2. Close database after operations
   ```typescript
   try {
     // Use database
   } finally {
     await closeSppDatabase();
   }
   ```

3. Monitor memory in development
   ```bash
   # iOS Simulator
   Debug → View Memory Hierarchy
   
   # Android Studio
   Profiler → Memory
   ```

## Testing Issues

### Issue: Tests fail with "expo-sqlite not mocked"

**Symptoms**:
```
ERROR: expo-sqlite is not mocked
TypeError: Cannot read property 'openDatabaseAsync'
```

**Solutions**:
1. Ensure jest.mock() is at top of test file
   ```typescript
   jest.mock('expo-sqlite');
   jest.mock('../storage');  // secure store
   ```

2. Verify mock is before imports
   ```typescript
   // Wrong
   import storage from './storage';
   jest.mock('expo-sqlite');
   
   // Right
   jest.mock('expo-sqlite');
   import storage from './storage';
   ```

3. Use the provided test mocks
   ```typescript
   const mockDb = {
     execAsync: jest.fn(),
     runAsync: jest.fn(),
     allAsync: jest.fn(),
     getFirstAsync: jest.fn(),
     closeAsync: jest.fn(),
   };
   
   (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);
   ```

### Issue: "Cannot find module" in tests

**Symptoms**:
```
ERROR: Cannot find module '../storage'
ENOENT: no such file or directory
```

**Solutions**:
1. Verify import paths are correct
   ```typescript
   // frontend/mobile/lib/privacy/__tests__/storage.test.ts
   import * as storage from '../storage';  // Up one level to storage.ts
   import * as secureStore from '../../storage';  // Up two levels to storage.ts
   ```

2. Check test file is in correct location
   ```
   frontend/mobile/lib/privacy/__tests__/storage.test.ts
   ✓ Correct location for storage tests
   ```

3. Run tests from correct directory
   ```bash
   cd frontend/mobile
   npm test -- --testPathPattern=privacy/storage
   ```

## Security Issues

### Issue: Encryption keys appearing in logs

**Symptoms**:
```
Logs contain: "key: 'a1b2c3d4e5f6...'"
Encryption key visible in console output
```

**Solutions**:
1. Never log encryption keys
   ```typescript
   // Wrong
   const key = await getSppEncryptionKey(walletAddress);
   console.log('Key:', key);  // NEVER DO THIS
   
   // Right
   const key = await getSppEncryptionKey(walletAddress);
   console.log('Key available:', !!key);  // Log boolean instead
   ```

2. Check for console.log in storage.ts
   ```bash
   grep "console.log.*key" frontend/mobile/lib/privacy/storage.ts
   # Should return nothing
   ```

3. Disable debug logging in production
   ```typescript
   function log(msg, data) {
     if (__DEV__) {
       console.log(`[spp-storage] ${msg}`, data);
     }
   }
   ```

### Issue: Database file readable in plaintext

**Symptoms**:
```
Can read database file as text
Data visible without encryption key
Binary content looks like random bytes (good)
```

**Solutions**:
1. Verify encryption is enabled
   ```bash
   # File should be binary
   file veil_spp_state.db
   # Should show: SQLite 3.x database, encrypted
   ```

2. Try accessing without key
   ```bash
   sqlite3 veil_spp_state.db "SELECT * FROM notes;"
   # Should fail: "file is encrypted or is not a database"
   ```

3. Verify PRAGMA key is set before queries
   ```typescript
   const db = await getSppDatabase(walletAddress);
   // Internally sets: PRAGMA key = "x'{hexKey}'"
   ```

## Contact & Support

For issues not listed here:
1. Check [README.md](./README.md) - Quick reference
2. Review [STORAGE_IMPLEMENTATION.md](./STORAGE_IMPLEMENTATION.md) - Architecture
3. Check [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) - SDK integration
4. Open issue on GitHub with `[SPP Storage]` prefix

---

**Last Updated**: September 25, 2026  
**Version**: 1.0  
**Status**: Troubleshooting guide complete
