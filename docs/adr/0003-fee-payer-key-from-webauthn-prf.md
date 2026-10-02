# ADR 0003 — Fee-Payer Key From WebAuthn PRF, Not the Credential ID

| Field     | Value                          |
|-----------|--------------------------------|
| Status    | Accepted — implemented (web wallet) 2026-08-10 |
| Date      | 2026-08-09 (implemented 2026-08-10) |
| Deciders  | Veil core team                 |
| Supersedes | The `lib/deriveFeePayer.ts` credential-ID derivation |

---

## Context

Veil uses a **two-account model** (see ADR 0001): a P-256 passkey signer that authorizes the
smart-wallet contract (`C…`), and a separate Ed25519 **fee-payer** account (`G…`) that pays the
Stellar transaction fees. The fee-payer's secret seed lives client-side as `veil_signer_secret`.

An external security assessment (2026-08-05) flagged two findings against this key, which on
inspection are the **same key with two independent exposures**:

- **C2 — derived from a non-secret.** `lib/deriveFeePayer.ts` runs `HKDF(credentialId)` to produce
  the Ed25519 seed. A WebAuthn **credential ID is not a secret**: it is stored in plaintext
  (`invisible_wallet_key_id`), returned in `allowCredentials` during every ceremony, and observable
  by any relying party. Anyone who reads it can reconstruct the fee-payer keypair deterministically,
  **with no biometric prompt**. The code comment claiming the key is "device-bound but recoverable
  via biometrics" describes a property the construction does not provide.

- **C3 — persisted in plaintext.** The same seed (`app/page.tsx:65` derives it, then writes it) is
  stored raw in `localStorage` as `veil_signer_secret` across ~25 read sites, and `app/lock/page.tsx`
  copies it from `sessionStorage` back into `localStorage` on unlock so it survives the inactivity
  lock — which means the lock protects nothing at rest.

Because the key is *already* recoverable from the public credential ID (C2), persisting it (C3) adds
attack surface without adding capability. Both stem from one root mistake: **treating the credential
ID as if it were secret.**

**Scope note.** The assessment's acute exploit chain was C1 (agent-chat XSS) + C3 + H1 (no CSP) — a
crafted agent message exfiltrating the plaintext key. C1 and H1 are already fixed (`4b2cf09`), so the
*remote* drain path is closed. This ADR addresses the residual: the key's protection is still weaker
than the product's "no seed phrases, no private keys" positioning claims.

---

## Decision

Derive the fee-payer key from a **WebAuthn PRF** output instead of the credential ID, and stop
persisting the plaintext seed. The primitive already exists in the SDK: `sdk/src/crypto/prf.ts`
evaluates the PRF extension during an assertion (`userVerification: 'required'`) and returns a
high-entropy secret that **only the passkey can produce** — a value an attacker reading storage
cannot reconstruct.

```
passkey assertion (PRF eval, salt = veil:feepayer/v1)
      │
      ▼  raw PRF output (32B, secret — never leaves the ceremony)
   HKDF-SHA256  (info = veil:feepayer:ed25519:v1)
      │
      ▼  32-byte Ed25519 seed  →  fee-payer Keypair (G…)
```

Rules:

1. **No credential-ID derivation.** `deriveFeePayerKeypair(credentialId)` is removed. The seed comes
   from PRF output, so it is genuinely passkey-gated.
2. **No plaintext seed at rest.** `veil_signer_secret` is never written to `localStorage`. The key is
   re-derived from the PRF each time it is needed, or held in memory for the unlocked session only.
   Nothing recoverable-from-storage remains. (If a session cache is kept, encrypt it with the
   PRF-bound `LocalCipher` from `prf.ts` — never store the raw seed.)
3. **Piggyback on the signing ceremony.** The wallet already runs a passkey assertion to authorize
   every transaction (`__check_auth`). Add `extensions.prf.eval` to *that* assertion, so the
   fee-payer key is derived from the same biometric prompt the user already gives — **no extra
   prompt** in the common path.
4. **Graceful fallback.** Where PRF is unsupported (older authenticators), `prf.ts` already falls
   back to a random key persisted via the storage adapter. For the fee-payer we prefer to *require*
   PRF (fail closed with a clear message) rather than silently fall back to a storage-bound key —
   `LocalCipher.mode === 'fallback'` should be surfaced to the user.

---

## Migration

Changing the derivation **changes the fee-payer `G…` address** for every wallet, so existing
fee-payer balances would be stranded. Phased rollout:

1. **Ship dual-read.** New code derives the *new* (PRF) fee-payer but can still read the *old*
   (credential-ID) one. On first post-upgrade transaction, **sweep** the old fee-payer's XLM to the
   new one, then stop using the old.
2. **Stop writing plaintext** immediately (C3) — the old key stays derivable from the credential ID
   during the sweep window, so no funds are lost.
3. **Remove the credential-ID path** (C2) once the sweep has run for active wallets. The 3 testnet
   wallets can be swept manually.
4. Update the ~25 `veil_signer_secret` read sites to a single accessor (`getFeePayer()`) that returns
   the in-memory session key, deriving via PRF on demand.

The `NEXT_PUBLIC` env and the Supabase `contract_address → fee_payer_address` mapping (see M6) must
be updated to the new address as wallets migrate.

---

## Consequences

**Positive.** The fee-payer key becomes genuinely passkey-bound; nothing secret is persisted;
`app/lock` actually protects the key at rest; the product's security positioning becomes accurate.

**Negative / risks.** Fee-payer addresses change (one-time sweep per wallet); PRF is not universally
supported (needs the fallback-vs-fail-closed decision above); the ~25 read sites are a broad but
mechanical refactor; deriving on demand adds latency to the first tx of a session (mitigated by the
in-memory cache + PRF-on-the-signing-assertion).

**Not addressed here.** The *recovery* private key in browser storage (M7) is the same exposure class
and should follow the same pattern in a follow-up.

---

## Implementation (2026-08-10, web wallet)

Shipped, with two deliberate refinements to the plan above that make the rollout
safe to land without a fund-moving migration:

1. **Mode is pinned per wallet, not force-migrated.** `lib/feePayer.ts` records a
   `veil_feepayer_mode` marker (`prf` | `legacy`). A **new** wallet tries PRF at
   creation and pins whichever mode actually worked; an **existing** wallet (one
   that already has a persisted secret) stays **legacy**, so its funded `G…`
   address never moves. This avoids stranding balances entirely — there is no
   forced sweep. To move an existing testnet wallet onto PRF, reset it (danger
   zone) and re-create, or sweep its legacy `G…` manually.
2. **PRF seed lives in `sessionStorage` + memory, never `localStorage`.** This is
   the concrete form of "no plaintext at rest" (C3): the seed is cleared on lock /
   tab close and re-derived from the passkey on the next assertion, so the
   inactivity lock actually protects it. (A pure in-memory cache was rejected as
   too fragile against the many synchronous read sites; sessionStorage-for-the-
   active-session, with the acute XSS path already closed by C1/H1, is the
   pragmatic middle ground.)

Other implementation facts:

- **New primitive** `deriveFeePayerSeedFromPrf()` + `evaluateFeePayerPrf()` in
  `sdk/src/crypto/prf.ts` (the module previously produced only an AES cipher).
- **PRF enabled at enrolment** — `webauthn.ts` registration now requests
  `extensions: { prf: {} }`; authenticators without PRF ignore it and the wallet
  falls back to legacy (**no brick** — the user's chosen safety property).
- **Piggybacked on the unlock assertion** — `app/lock/page.tsx` adds `prf.eval`
  to the single unlock `navigator.credentials.get`, so a PRF wallet unlocks with
  no extra prompt.
- **Single accessor** — create / recover / unlock / dashboard all establish the
  key through `ensureFeePayer()`; the ~30 downstream read sites keep reading
  `sessionStorage` (which the accessor populates), so no address mismatch.
- **Not yet done:** the mobile app port (`frontend/mobile/lib/deriveFeePayer.ts`
  — same pattern, `react-native-passkeys` PRF + noble HKDF) and the recovery key
  (M7) follow in a follow-up. Mobile's exposure is milder (keychain, not
  `localStorage`).

## Status of the interim state

Until this lands, `lib/deriveFeePayer.ts` carries a `SECURITY` note documenting the real (weak)
property so no reader mistakes it for passkey-bound. The acute remote-exfiltration chain is already
closed (C1/H1 fixed); this ADR removes the residual weakness.
