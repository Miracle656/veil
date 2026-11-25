# invisible-wallet-sdk

## 1.0.0

### Major / Breaking Changes

- **Retired secret-bearing signer overloads (`#1312`):**
  - `SignerInput` now accepts exclusively `TransactionSigner`. The deprecated `Keypair` and `string` (Stellar secret key) inputs have been removed from all wallet and SDK methods (`deploy`, `addSigner`, `registerAdditionalSigner`, `removeSigner`, `rotateSigner`, `setGuardian`, `initiateRecovery`, `completeRecovery`, `approve`, `sendPayment`, etc.).
  - Removed `sponsorSecret` from `WalletConfig`. Network fee sponsorship must now be configured via `sponsorSigner?: TransactionSigner`.
  - Removed deprecated `senderKeypair` and `claimantKeypair` options from `createEscrow`, `claimEscrow`, and `reclaimEscrow`. Use `sender: TransactionSigner` and `claimant: TransactionSigner`.
  - Added and exported `createKeypairSigner(keypair: Keypair): TransactionSigner` helper for backend services, test harnesses, or CLI scripts where a Keypair is already securely held in memory.
  - Migrated the first-party web wallet (`frontend/wallet`) completely off secret strings and Keypairs when invoking the SDK.

See `docs/MIGRATION_V1_SIGNERS.md` for before/after migration examples.

## 0.2.0

### Minor Changes

- 0afa16e: Initial release of `invisible-wallet-sdk`:
  - Client SDK for Invisible Wallet (Soroban + WebAuthn passkeys).
  - Verified subpath exports for default (`.`), `./vanilla`, `./react`, and `./vue`.
  - ESM modules and TypeScript type definitions for Web, React Native, and Node environments.
  - Standalone documentation and quick-start guides for React, Vue 3, and framework-agnostic usage.
