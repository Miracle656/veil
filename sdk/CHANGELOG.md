# invisible-wallet-sdk

## 0.3.0

### Minor Changes

- fd2f39a: Consolidate React Native passkeys onto `react-native-passkeys` (breaking for RN consumers).

  The SDK's native WebAuthn provider (`webauthn.native.ts`) previously required the
  `react-native-passkey` package, while apps that also needed PRF assertions and
  discoverable sign-in had to add `react-native-passkeys` — two libraries wrapping the
  same platform API, pinning different `androidx.credentials` versions. `npm install
invisible-wallet-sdk` still works unchanged (both peers were optional), but React
  Native installs must now provide `react-native-passkeys` instead of
  `react-native-passkey`:

  ```bash
  npm install react-native-passkeys
  ```

  Registration now runs through `react-native-passkeys.create()`: same challenge/RP/user
  encoding, same `extensions: { prf: {} }` PRF enrolment, same base64url SPKI, so the
  derived P-256 public key — and therefore the wallet address — is byte-for-byte
  unchanged. Assertions return `publicKeyBytes: null` explicitly (platform passkeys do
  not expose the key on assertions; this matches the documented interface and the
  previous native behaviour, which left it unset).

### Patch Changes

- 8377e38: Add `repository`, `homepage`, `bugs` and `engines` to the published manifest, so
  the npm page links back to the source, the SDK reference and the issue tracker.
  `engines.node` is `>=20`, the version every CI job that builds or tests the SDK
  runs on. `repository` carries `directory: "sdk"`, which npm provenance needs to tie
  a published build to the commit that produced it.

## 0.2.0

### Minor Changes

- 0afa16e: Initial release of `invisible-wallet-sdk`:
  - Client SDK for Invisible Wallet (Soroban + WebAuthn passkeys).
  - Verified subpath exports for default (`.`), `./vanilla`, `./react`, and `./vue`.
  - ESM modules and TypeScript type definitions for Web, React Native, and Node environments.
  - Standalone documentation and quick-start guides for React, Vue 3, and framework-agnostic usage.
