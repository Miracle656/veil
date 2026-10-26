# SEP-43 Conformance Specification for Veil

**Standard:** [SEP-0043: Standard Web Wallet API Interface](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md)  
**Status:** Implemented  
**Date:** 2026-10-19  

---

## 1. Executive Summary & Architecture

SEP-43 defines the standard wallet API interface for the Stellar ecosystem. Connector libraries—chief among them Stellar Wallets Kit (`@creit-tech/stellar-wallets-kit`) via its `sep43Modules()` registry—use SEP-43 to interact with wallets without requiring bespoke integration logic.

Veil is a non-custodial smart contract wallet. Every Veil wallet account is a deployed Soroban contract account with a deterministic contract address. Authorization on Soroban contract accounts is governed by Soroban's `__check_auth` interface, which is contract-agnostic: the user's WebAuthn passkey signs a Soroban authorization entry hash (`SorobanAuthorizationEntry`), and an external fee-payer account sponsors and signs the outer transaction envelope.

Because `__check_auth` is contract-agnostic and evaluated on-chain, SEP-43 conformance is strictly **client-side work**. No smart contract modifications are required or possible.

Veil implements the SEP-43 standard surface as a single shared implementation located in `sdk/src/sep43.ts`. This single implementation powers:
1. The **SDK** via `InvisibleWalletCore.getSep43Wallet()`
2. The **Injected Provider** (`window.stellar.veil` and `window.veil`)
3. The **WalletConnect v2** bridge in `frontend/wallet/lib/walletConnect.ts` and `frontend/mobile/lib/walletConnect.ts`

---

## 2. Method-by-Method Conformance Analysis

### 2.1 `getAddress`

#### Specification
```typescript
getAddress: () =>
  Promise<{
    address: string;
  } & error?: Error>
```

#### Veil Conformance: Conforms
- **Behavior:** Returns the user's active wallet address. For smart wallets, this is the 56-character Soroban contract address beginning with `C`. For classic keypair wallets, this is the 56-character Ed25519 public key beginning with `G`.
- **Response Shape:**
  - Success: `{ address: string }`
  - Error: `{ address: '', error: { code: -3, message: 'No wallet available' } }`
- **Error Codes:**
  - `-3`: Wallet not registered or not unlocked.

---

### 2.2 `getNetwork`

#### Specification
```typescript
getNetwork: () =>
  Promise<{
    network: string;
    networkPassphrase: string;
  } & error?: Error>
```

#### Veil Conformance: Conforms
- **Behavior:** Returns the current network name and network passphrase configured in the wallet.
- **Response Shape:**
  - Success: `{ network: string, networkPassphrase: string }`
  - For Testnet: `{ network: 'TESTNET', networkPassphrase: 'Test SDF Network ; September 2015' }`
  - For Public Network: `{ network: 'PUBLIC', networkPassphrase: 'Public Global Stellar Network ; September 2015' }`
  - Error: `{ error: { code: -1, message: string } }`

---

### 2.3 `signTransaction`

#### Specification
```typescript
signTransaction: (
  xdr: string,
  opts?: {
    networkPassphrase?: string;
    address?: string;
    submit?: boolean;
    submitUrl?: string;
  }
) =>
  Promise<{
    signedTxXdr: string;
    signerAddress: string;
  } & error?: Error>
```

#### Veil Conformance: Conforms
- **Behavior:**
  1. Validates `opts.networkPassphrase` (if provided): must match the wallet's configured network passphrase. If it differs, execution fails with client error code `-3`.
  2. Validates `opts.address` (if provided): must match the wallet address. If it differs, execution fails with client error code `-3`.
  3. Transaction Signing Ceremony:
     - The transaction XDR is decoded.
     - Recording-mode simulation produces required Soroban authorization entries with a real future ledger sequence (`latestLedger + 100`).
     - The user is prompted with the passkey signing ceremony (`signAuthEntry`).
     - A 5-element signature vector `[publicKey, authData, clientDataJSON, signature, nonce]` is attached to the contract credentials.
     - The transaction is re-simulated in `enforce` mode to generate the Soroban storage footprint.
     - The fee-payer account signs the transaction envelope.
  4. Submission (`opts.submit === true`):
     - When `submit: true` is requested, the wallet submits the signed transaction via RPC to `opts.submitUrl` (or the wallet's configured RPC endpoint).
     - If the RPC rejects the submission, an external service error (code `-2`) is returned.
- **Response Shape:**
  - Success: `{ signedTxXdr: string, signerAddress: string }`
  - Error: `{ signedTxXdr: '', signerAddress: '', error: { code: number, message: string } }`
- **Error Codes:**
  - `-3`: Invalid parameters, network mismatch, address mismatch, or user rejection (`USER_REJECTED`).
  - `-2`: External RPC simulation failure or network submission failure.
  - `-1`: Unexpected internal wallet error.

---

### 2.4 `signAuthEntry`

#### Specification
```typescript
signAuthEntry: (
  authEntry: string,
  opts?: {
    networkPassphrase?: string;
    address?: string;
  }
) =>
  Promise<{
    signedAuthEntry: string;
    signerAddress: string;
  } & error?: Error>
```

#### Veil Conformance: Conforms
- **Behavior:**
  1. Accepts `authEntry` as a base64-encoded `xdr.SorobanAuthorizationEntry`.
  2. Validates `opts.networkPassphrase` (if provided): must match the wallet's configured network passphrase.
  3. Decodes the entry and verifies that `credentials` are address-credentials (`sorobanCredentialsAddress`).
  4. Validates that the entry's address matches the wallet address (and `opts.address` if provided).
  5. Computes the canonical authorization preimage:
     `HashIdPreimage.envelopeTypeSorobanAuthorization` using the network ID, entry nonce, root invocation, and signature expiration ledger.
  6. Prompts the WebAuthn passkey to sign the 32-byte preimage hash.
  7. Attaches the 5-element WebAuthn signature vector to the authorization credentials.
  8. Re-encodes the signed authorization entry to base64.
- **Response Shape:**
  - Success: `{ signedAuthEntry: string, signerAddress: string }`
  - Error: `{ signedAuthEntry: '', signerAddress: '', error: { code: number, message: string } }`
- **Error Codes:**
  - `-3`: Invalid entry XDR, credentials not address-based, address mismatch, or user rejection (`USER_REJECTED`).
  - `-1`: Unexpected internal error.

---

### 2.5 `signMessage`

#### Specification
```typescript
signMessage: (
  message: string,
  opts?: {
    networkPassphrase?: string;
    address?: string;
  }
) =>
  Promise<{
    signedMessage: string;
    signerAddress: string;
  } & error?: Error>
```

#### Veil Conformance: Conforms (with Smart-Contract Passkey Semantics)
- **Behavior:**
  1. Accepts `message: string` and optional parameters.
  2. Validates `opts.address` against the wallet address if provided.
  3. Signs the message using Veil's domain-separated WebAuthn specification (`VEIL_SIGNED_MESSAGE_V1`).
  4. Returns the JSON-serialized `SignedMessage` containing:
     - `version: 1`
     - `domain: 'VEIL_SIGNED_MESSAGE_V1'`
     - `messageHash`: SHA-256 of the domain-separated message
     - `credentialId`: WebAuthn credential identifier
     - `signature`: Raw 64-byte P-256 ECDSA signature (hex)
     - `publicKey`: P-256 public key (hex)
     - `authData`: Authenticator data (hex)
     - `clientDataJSON`: Client data JSON (hex)
- **Response Shape:**
  - Success: `{ signedMessage: string, signerAddress: string }`
  - Error: `{ signedMessage: '', signerAddress: '', error: { code: number, message: string } }`
- **Deliberately Unsupported:**
  - **Raw Ed25519 Secret Key Signing:** Veil smart wallets are governed by WebAuthn P-256 authenticators, not raw 32-byte Ed25519 seed keys. The wallet does not hold a private key that could produce an Ed25519 signature over arbitrary raw bytes.
  - **Arbitrary Unstructured Byte Signing:** Direct signing of arbitrary unhashed binary data without WebAuthn clientDataJSON binding is rejected to prevent signature reuse across different protocols or transactions.

---

## 3. Error Model Conformance

SEP-43 specifies standard error shapes:

```typescript
interface Error {
  message: string;
  code: number;
  ext?: Array<string>;
}
```

The error codes are strictly mapped as follows:
- `code: -1` — **Internal wallet error**: Logic error within the wallet.
- `code: -2` — **External service error**: RPC failure, Horizon error, simulation error, or network timeout.
- `code: -3` — **Client app request error**: User rejection (`USER_REJECTED`), invalid XDR, network passphrase mismatch, address mismatch, or uninitialized wallet.

Veil's implementation adheres to this exact error structure across all five methods. When an error occurs, the promise resolves with `{ error: { message, code, ext } }`, ensuring callers can inspect `.error` without catching unexpected exceptions.

---

## 4. Single Shared Implementation

Veil implements the SEP-43 standard once in `sdk/src/sep43.ts`:

```
                           ┌──────────────────────────┐
                           │      sdk/src/sep43.ts    │
                           │   (createSep43Wallet)    │
                           └─────────────┬────────────┘
                                         │
                 ┌───────────────────────┼───────────────────────┐
                 │                       │                       │
                 ▼                       ▼                       ▼
     ┌───────────────────────┐ ┌───────────────────┐ ┌───────────────────────┐
     │   Injected Provider   │ │   WalletConnect   │ │          SDK          │
     │ window.stellar.veil   │ │  Session Request  │ │  InvisibleWalletCore  │
     │      window.veil      │ │      Router       │ │     getSep43Wallet    │
     └───────────────────────┘ └───────────────────┘ └───────────────────────┘
```

Every consumer interacts with the same validation rules, simulation leeway, ledger expiration offsets, signature formatting, and error codes.
