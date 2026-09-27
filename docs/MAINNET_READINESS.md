# Mainnet readiness

Tracks the outstanding items from the 2026-08-05 external security assessment and their
current status. This file did not exist before this PR; issue #682 referred to it as
already recording the mobile fee-payer gap, so it is created here with that history
folded in rather than starting from a blank slate.

| Surface | Status | Notes |
|---|---|---|
| Web wallet | Mainnet-safe for C2/C3 | See `docs/adr/0003-fee-payer-key-from-webauthn-prf.md`. PRF-derived fee payer (`'prf-raw'` mode) for new wallets; legacy wallets pinned to their existing derivation so no funded address moves. |
| Mobile | **Improved, not yet certified mainnet-safe** | See below. |
| M3 (on-curve pubkey validation) | Tracked separately | Out of scope for this PR — see issue #682's notes. Not addressed here. |

## Mobile — C2 / C3 (fee-payer derivation)

**Before this PR:** `createPasskeyWallet` already attempted PRF-based derivation and fell
back to a random (not credential-ID-derived) key on failure, but this was undocumented,
untested at the wallet-creation level, and the dead legacy credential-ID path
(`lib/deriveFeePayer.ts`) remained in the codebase with no regression test proving it
stays unreachable.

**After this PR:**

- `lib/__tests__/passkeyWallet.test.ts` pins down, as executable tests: the fee payer is
  PRF-derived when PRF succeeds; the credential id alone does not reproduce it (C2); PRF
  failure produces an explicit `recoverable: false` degrade rather than a silent legacy
  fallback; and mobile agrees with the web wallet's `'prf-raw'` address for the same PRF
  output (a shared golden fixture in both test suites).
- `docs/MOBILE_PRF_FINDINGS.md` records the code-level audit that established the above.

**Still open, and why this is not marked "mainnet-safe" outright:**

1. **PRF availability across real iOS/Android hardware and authenticators is not
   empirically verified.** The derivation is correct when PRF succeeds, and the fallback
   is explicit (not silent) when it does not — but which devices actually return `ok`
   versus `unsupported` has not been measured on physical hardware. See
   `docs/MOBILE_PRF_FINDINGS.md` for exactly what is and is not covered.
2. **The derived secret is persisted in the OS keychain (`lib/walletStore.ts`'s
   `setSignerSecret`, backed by `lib/storage.ts`'s secure store), not held purely
   in-memory for the session.** This is a materially different (and, per ADR 0003,
   milder) exposure than web's pre-fix plaintext `localStorage`, since the keychain is
   OS-encrypted and not readable from JS/webview context — but it is not the literal
   "never written to persistent storage, cleared on lock" property the web wallet's
   `sessionStorage`-only `'prf-raw'`/`'prf-hkdf'` modes provide. Migrating mobile to a
   pure in-memory/session cache would touch every one of the ~15 call sites that
   currently read `getSignerSecret()` synchronously-on-mount, and is a larger, riskier
   change than this PR's scope; it is recorded here as the concrete remaining gap rather
   than silently accepted as "good enough."

**Recommendation:** mobile is meaningfully closer to mainnet-safe after this PR (PRF
derivation is now proven correct and regression-tested, and the fallback behavior is
explicit rather than silent), but a full sign-off should wait on (1) a real-device PRF
availability pass and (2) a decision on whether the keychain-persistence gap in point 2 is
acceptable for launch or needs the in-memory-session refactor.
