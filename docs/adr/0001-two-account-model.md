# ADR 0001 — Two-Account Model (C… contract + G… fee-payer)

| Field     | Value                      |
|-----------|----------------------------|
| Status    | Accepted                   |
| Date      | 2024-01-15                 |
| Deciders  | Veil core team             |

---

## Context

Stellar Soroban custom account contracts (`C…` addresses) pay transaction fees in XLM, but they cannot fund themselves at inception — a bootstrapping problem.  The network also requires that every transaction be signed by a classic `G…` key so that the fee reserve can be enforced before any smart-contract logic runs.

Passkey-derived keys are P-256 (secp256r1) ECDSA keys.  The Stellar network's built-in signature verification only understands Ed25519 (`G…` keys).  There is therefore no direct way to pay fees from a passkey-controlled account without an intermediate account.

Additionally, the Soroban runtime distinguishes between two types of authorization:

1. **Transaction-level authorization** — who pays the fee and submits the envelope (must be a `G…` key).
2. **Custom account authorization** — `__check_auth` on the wallet contract, which enforces passkey verification.

These two concerns are deliberately orthogonal in Veil.

---

## Decision

Veil separates every wallet into two on-chain accounts:

| Account | Kind | Address prefix | Key type | Role |
|---------|------|----------------|----------|------|
| **Smart wallet** | Soroban contract | `C…` | P-256 (passkey) | Holds user assets, enforces passkey auth for every operation |
| **Fee-payer** | Classic Stellar account | `G…` | Ed25519 (deterministic) | Pays transaction fees, signs the transaction envelope |

### Fee-payer key derivation

The fee-payer keypair is derived deterministically from the user's WebAuthn credential ID using HKDF-SHA256:

```
seed = HKDF-SHA256(
  ikm  = credentialId,
  salt = "veil:feepayer:salt:v1",
  info = "veil:feepayer:ed25519:v1",
  len  = 32
)
feePayerKeypair = Ed25519(seed)
```

This means:
- The user never sees or manages a seed phrase for the fee-payer.
- The same device passkey always regenerates the same fee-payer keypair.
- After a browser-cache clear, the fee-payer can be recovered from the passkey credential ID stored in `localStorage`.

### Authorization flow for every transaction

```
User device                          Stellar network
────────────────────────────         ──────────────────────────────────
1. Build transaction
   └─ operation on wallet C...
   └─ fee source = G... fee-payer

2. Passkey assertion
   └─ navigator.credentials.get()
   └─ produces authData + sig

3. Attach WebAuthn signature
   └─ Vec<Val>[pubkey, authData,
      clientDataJSON, sig, nonce]
      as the auth entry credential

4. Sign envelope with fee-payer G...

5. Submit to Soroban RPC
                                     6. Network verifies envelope sig (G...)
                                     7. Contract __check_auth() runs
                                        └─ verifies P-256 passkey sig
                                        └─ checks nonce (anti-replay)
                                        └─ verifies RP ID + origin
                                     8. Operation executes
```

---

## Consequences

### Positive

- **No seed phrases** — users authenticate purely with their device biometrics.
- **Portable** — the fee-payer key is always recoverable from the passkey credential ID without any backup phrase.
- **Clear separation of concerns** — fee payment is independent of wallet authorization logic.
- **Standard Stellar compatibility** — the fee-payer `G…` account works with all existing Stellar tooling (Horizon, Friendbot, explorers).

### Negative / Trade-offs

- **Two accounts to manage** — the fee-payer account must be funded with a small XLM reserve (testnet: Friendbot, mainnet: onboarding flow).
- **Storage dependency** — the credential ID must be in `localStorage` to derive the fee-payer on recovery.  Cross-device recovery requires re-registering a new passkey.
- **Fee-payer exposure** — the fee-payer keypair is stored in `localStorage` / `sessionStorage`.  It controls no assets and cannot authorize wallet operations, so its compromise is low-risk but should be understood.
- **Minor UX friction on cache clear** — after clearing browser storage, the app shows a "Set up fee-payer" banner until the user re-derives the keypair via their passkey.

### Alternatives considered

| Alternative | Why rejected |
|-------------|-------------|
| Single passkey-only account with no fee-payer | Stellar's fee system requires an Ed25519 signer on the transaction envelope; P-256 keys cannot fulfill this role natively |
| User-managed seed phrase for the fee-payer | Defeats the "no seed phrase" goal and adds key-management burden |
| Server-side fee sponsorship (fee bumps) | Introduces a centralized server dependency and requires the server to sign every transaction, weakening self-custody |
| Stellar fee sponsorship (account merging / sequence tricks) | Operationally complex and requires coordinated on-chain state; deterministic derivation is simpler and equally recoverable |

---

## Related

- [ADR 0002 — WebAuthn Signature Verification On-Chain](./0002-webauthn-signature-verification.md)
- `sdk/src/useInvisibleWallet.ts` — `deploy()` and `register()` implement this model
- `frontend/wallet/lib/deriveFeePayer.ts` — HKDF derivation of the fee-payer keypair
