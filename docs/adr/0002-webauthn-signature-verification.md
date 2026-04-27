# ADR 0002 — WebAuthn Signature Verification On-Chain

| Field     | Value                      |
|-----------|----------------------------|
| Status    | Accepted                   |
| Date      | 2024-01-15                 |
| Deciders  | Veil core team             |

---

## Context

Veil's smart wallet contract verifies P-256 ECDSA signatures produced by WebAuthn passkeys entirely on-chain inside a Soroban `__check_auth` hook.  This is non-trivial for two reasons:

1. **Encoding mismatch** — browsers return signatures in ASN.1 DER format; Soroban's `secp256r1_verify` (via the `p256` crate) expects raw `r ‖ s` (64 bytes).
2. **Challenge binding** — the contract must confirm that the WebAuthn assertion was produced for the *exact* Soroban authorization payload, not some other transaction.

Without a documented design the pipeline is opaque to contributors and auditors.

---

## Key format: P-256 (secp256r1 / ES256)

WebAuthn mandates COSE algorithm **ES256** (IANA COSE Algorithms registry, value `-7`), which corresponds to **P-256 ECDSA with SHA-256**.

A P-256 public key is stored on-chain as an **uncompressed SEC1 point**:

```
0x04 ‖ x (32 bytes) ‖ y (32 bytes)  →  65 bytes total (BytesN<65>)
```

The private key lives in the device's secure enclave and never leaves hardware.

---

## Signature pipeline: browser → contract

### Step 1 — WebAuthn assertion (browser)

```typescript
const assertion = await navigator.credentials.get({
  publicKey: {
    challenge:          signaturePayload,          // 32-byte Soroban auth payload (used verbatim)
    allowCredentials:   [{ id: credId, type: 'public-key' }],
    userVerification:   'required',
  },
}) as PublicKeyCredential
```

The authenticator produces three outputs:
- `authenticatorData` — binary struct (≥37 bytes, see layout below)
- `clientDataJSON` — UTF-8 JSON containing `"challenge": "<base64url(signaturePayload)>"`
- `signature` — ASN.1 DER-encoded P-256 ECDSA signature over `SHA-256(authData ‖ SHA-256(clientDataJSON))`

### Step 2 — DER → raw conversion (client SDK, `sdk/src/utils.ts`)

WebAuthn returns signatures in **ASN.1 DER** format:

```
30 <total_len>
  02 <r_len> <r>
  02 <s_len> <s>
```

Both `r` and `s` may be padded with a leading `0x00` byte when the high bit is set (to signal a positive integer in DER).  The contract expects the raw concatenation without padding:

```typescript
function derToRawSignature(derBytes: ArrayBuffer): Uint8Array {
  // Parse DER envelope: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  const der = new Uint8Array(derBytes)
  const rLen = der[3]
  const rStart = 4
  const sLen = der[rStart + rLen + 1]
  const sStart = rStart + rLen + 2

  // Strip leading 0x00 padding bytes introduced by DER positive-integer encoding
  const r = der.slice(rLen > 32 ? rStart + 1 : rStart, rStart + rLen)
  const s = der.slice(sLen > 32 ? sStart + 1 : sStart, sStart + sLen)

  const raw = new Uint8Array(64)
  raw.set(r, 32 - r.length)  // right-align into 32 bytes
  raw.set(s, 64 - s.length)
  return raw  // r ‖ s, each exactly 32 bytes
}
```

### Step 3 — XDR structure passed to the contract

The signature credential attached to the Soroban `SorobanAuthorizationEntry` is a `Vec<Val>` with **five elements**:

| Index | Type | Description |
|-------|------|-------------|
| 0 | `BytesN<65>` | Uncompressed P-256 public key (`0x04 ‖ x ‖ y`) |
| 1 | `Bytes` | WebAuthn `authenticatorData` |
| 2 | `Bytes` | WebAuthn `clientDataJSON` |
| 3 | `BytesN<64>` | Raw ECDSA signature (`r ‖ s`) |
| 4 | `u64` | Current nonce from `get_nonce()` (replay protection) |

```rust
// contracts/invisible_wallet/src/lib.rs — __check_auth signature unpacking
let parts: Vec<Val> = Vec::try_from_val(&env, &signature)
    .map_err(|_| WalletError::InvalidSignatureFormat)?;
if parts.len() != 5 { return Err(WalletError::InvalidSignatureFormat); }
```

---

## On-chain verification pipeline (`contracts/invisible_wallet/src/auth.rs`)

### Step 1 — Signer authorization check

```rust
if !storage::has_signer(&env, &public_key) {
    return Err(WalletError::SignerNotAuthorized);
}
```

The public key must be in the wallet's registered signer set.

### Step 2 — Nonce validation (replay protection)

```rust
let stored_nonce = storage::get_nonce(&env);
if nonce != stored_nonce {
    return Err(WalletError::NonceMismatch);
}
// Nonce is incremented ONLY after all checks pass (Step 6)
```

The nonce is a monotonically-increasing `u64` stored in persistent contract storage.  Presenting a nonce other than the current value causes immediate rejection.  This prevents a captured WebAuthn assertion from being replayed in a future transaction.

### Step 3 — Challenge binding

```rust
// base64url-encode the 32-byte Soroban payload without padding
let encoded = base64url_encode_32(signature_payload.as_slice());
// Scan clientDataJSON bytes for the encoded challenge
if !challenge_is_present(&client_data_json, &encoded) {
    return Err(WalletError::InvalidChallenge);
}
```

The WebAuthn spec mandates that the authenticator embed `base64url(challenge)` verbatim inside `clientDataJSON`.  Because Veil passes the 32-byte Soroban `signature_payload` as the challenge, this check proves the assertion was produced specifically for *this* authorization — not for a different contract, function, or argument set.

### Step 4 — ECDSA signature verification

```rust
// Signed message = SHA-256(authData ‖ SHA-256(clientDataJSON))
let client_data_hash = sha256(&client_data_json);
let message = sha256(&[auth_data_bytes, client_data_hash].concat());

let verifying_key = VerifyingKey::from_sec1_bytes(&pub_key)
    .map_err(|_| WalletError::InvalidPublicKey)?;
verifying_key
    .verify_prehash(&message, &signature)
    .map_err(|_| WalletError::SignatureVerificationFailed)?;
```

### Step 5 — RP ID binding (domain pinning)

```rust
// auth_data[0..32] must equal SHA-256(rp_id)
auth::verify_rp_id(&rp_id, &auth_data)?;
```

`authenticatorData` always begins with the SHA-256 of the Relying Party ID (e.g., `SHA-256("veil.app")`).  This ensures the assertion was produced for the same origin as the contract was initialized with, preventing cross-site signature theft.

**Intentional ordering**: RP ID and origin checks run *after* signature verification to avoid producing a faster error path on domain mismatch (timing side-channel mitigation).

### Step 6 — Origin binding

```rust
// clientDataJSON must contain '"origin":"<stored_origin>"'
auth::verify_origin(&client_data_json, &origin)?;
```

### Step 7 — Nonce increment

```rust
storage::increment_nonce(&env);  // runs only on success
```

---

## authenticatorData binary layout

```
 0..32   rpIdHash     — SHA-256(rp_id), checked in Step 5
32       flags        — UP (bit 0) = user present; UV (bit 2) = user verified
33..36   signCount    — 4-byte big-endian monotonic counter (anti-clone signal)
37..     extensions   — optional CBOR data (not used by Veil)
```

---

## Nonce replay protection design

The nonce is a simple monotonic counter that solves two problems:

1. **Transaction replay** — a captured `(authData, clientDataJSON, sig)` triple is only valid for one transaction: the one where the nonce matches.
2. **Out-of-order submission** — if two signed transactions race, only one can succeed; the other is rejected with `NonceMismatch`.

The nonce is fetched client-side via `wallet.getNonce()` immediately before building the authorization entry and included in element `[4]` of the Vec.

---

## Alternatives considered

| Alternative | Why rejected |
|-------------|-------------|
| **secp256k1 (Bitcoin / Ethereum keys)** | Not supported by WebAuthn; browser secure enclaves exclusively use P-256 |
| **Ed25519 (Stellar native)** | Not a WebAuthn-supported algorithm; cannot be generated by device secure enclaves |
| **Server-side signature verification** | Centralizes trust, defeats self-custody, and requires a trusted relay |
| **Skip DER→raw conversion; pass DER directly** | Soroban's p256 crate `verify_prehash` expects raw 64-byte signatures; DER is variable-length and would require a no_std DER parser inside the contract, increasing contract size |
| **Hash the challenge before embedding** | WebAuthn embeds the raw base64url of the provided challenge bytes; hashing it would break the binding check since we'd no longer know what string to search for in `clientDataJSON` |
| **Timestamp-based replay protection instead of nonce** | On-chain timestamps (ledger close time) have ±5 s granularity; a nonce provides exact ordering and is simpler to implement correctly |

---

## Related

- [ADR 0001 — Two-Account Model](./0001-two-account-model.md)
- `contracts/invisible_wallet/src/auth.rs` — full verification implementation
- `contracts/invisible_wallet/src/lib.rs` — `__check_auth` entry point
- `sdk/src/utils.ts` — `derToRawSignature`, `extractP256PublicKey`
- `sdk/src/useInvisibleWallet.ts` — `signAuthEntry()`
