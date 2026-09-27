# Mobile WebAuthn PRF findings — fee-payer derivation (issue #682)

**Status:** code audit + unit-test verification complete; on-device OS/authenticator
matrix **not** verified (no physical iOS/Android hardware available in the environment
this work was done in — see "What could not be verified" below).
**Date:** 2026-09-27.

## What this is

ADR 0003 (`docs/adr/0003-fee-payer-key-from-webauthn-prf.md`) fixed two findings from the
2026-08-05 security assessment on **web**:

- **C2** — the fee-payer key was derivable from the (public) credential id.
- **C3** — the derived secret was persisted in plaintext `localStorage`.

The ADR's "Not yet done" section flagged the mobile port as outstanding. This note
records what a code-level audit of `frontend/mobile` found before writing the fix in this
PR, and what still needs a real device to close out.

## Finding 1 — the PRF derivation path already exists in `frontend/mobile/lib/passkey.ts`

`evaluatePrf()`, `nativePrfEvaluator()`, and `discoverWithPrf()` all run a
`react-native-passkeys` assertion with `extensions: { prf: { eval: { first: salt } } }` and
classify the result via `prfOutcome.ts` (`ok` / `unsupported` / `cancelled` / `failed`).
This is real WebAuthn PRF, not a placeholder — it was built for wallet recovery
(`loginWithPasskey` / `loginWithAddress` in `lib/passkeyLogin.ts`), and this PR is the
first place it is asked to do fee-payer derivation, using the SDK's fee-payer salt
constant.

## Finding 2 — wallet creation (`createPasskeyWallet` in `lib/passkeyWallet.ts`) already
attempted PRF, but the codebase's own dead legacy path made the actual security posture
easy to misjudge from the ADR text alone

Before this PR, `createPasskeyWallet` already tried `evaluatePrf` with the fee-payer salt
and, on success, derived the seed as the **raw PRF output** — the same convention the web
wallet's `'prf-raw'` mode uses (see `frontend/wallet/lib/feePayer.ts`). On failure it fell
back to `Keypair.random()`, not the credential-id derivation, and surfaced
`recoverable: false` to the caller rather than failing silently.

Separately, `frontend/mobile/lib/deriveFeePayer.ts` still exists — the credential-ID HKDF
derivation ADR 0003 calls C2 — but it is **not called from any live code path** (only
from its own test). It is exactly the kind of code that looks like a live vulnerability
when read in isolation (and is documented as one, correctly, in its own `SECURITY`
comment) but is not reachable from `createPasskeyWallet`, `loginWithPasskey`, or
`loginWithAddress`. This PR adds `lib/__tests__/passkeyWallet.test.ts`, which pins this
down as an executable regression check (C2 stated as a test: the credential id alone must
not reproduce the derived fee payer) rather than something a future refactor could
silently break.

## Finding 3 — cross-platform key agreement

Both platforms derive the fee-payer seed as the **raw PRF output**, used directly as the
Ed25519 seed (`Keypair.fromRawEd25519Seed(prf.subarray(0, 32))`), with the same fixed PRF
salt (`invisible-wallet/prf/feepayer/v1`, `FEE_PAYER_PRF_SALT` in
`sdk/src/crypto/prf.ts` and mirrored locally in `frontend/mobile/lib/passkeyWallet.ts` /
`passkeyLogin.ts`). This PR pins a golden fixture (PRF output = 32 bytes of `0x07` →
`G…GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57`) identically in
`frontend/wallet/lib/__tests__/feePayer.test.ts` and
`frontend/mobile/lib/__tests__/passkeyWallet.test.ts`, so the two platforms' derivations
cannot silently diverge without both tests failing.

## What could not be verified

The acceptance criteria for issue #682 ask for a findings note recording **PRF
availability on iOS and Android, at which OS/authenticator versions, including negative
results** — i.e., empirical testing against real hardware. That testing genuinely was not
possible in the environment this change was authored in: no physical iOS or Android
device, no access to a real platform authenticator (Face ID / Touch ID / Android
biometric + Credential Manager), and `react-native-passkeys`' native module is explicitly
unavailable under Expo Go (`lib/passkey.ts`'s `loadPasskeys()` throws a clear error in
that case, by design).

What this means concretely:

- The `prf.eval` extension request shape used here (`extensions: { prf: { eval: { first }
  } }`) matches the WebAuthn Level 3 PRF extension and `react-native-passkeys`' documented
  API, and the classification logic (`prfOutcome.ts`) already has full unit coverage. But
  whether a **given physical device** actually returns a PRF result — as opposed to
  `unsupported` — depends on the platform's passkey provider (iCloud Keychain, Google
  Password Manager, a third-party manager) and OS version, and that matrix has not been
  run.
- The existing code already treats an unsupported/failed PRF result as an **explicit,
  surfaced degrade** (`recoverable: false`, never a silent fallback to the credential-id
  derivation) rather than a silent failure, which satisfies the issue's "never silently
  fall back" requirement structurally, independent of which devices actually support PRF.
- Before this can be called mainnet-safe in the strict sense the issue asks for, someone
  with access to representative iOS and Android hardware needs to run
  `createPasskeyWallet` / `loginWithPasskey` on each and record whether `evaluatePrf`
  returns `ok` or `unsupported`, plus the OS and passkey-provider version. That table is
  the missing half of this note and is left as an explicit follow-up — filling it in with
  fabricated version numbers would be worse than leaving it blank.

## Recommendation

Given the above, this PR treats PRF-availability-on-device as **unconfirmed** rather than
assuming it is universally available: the fallback path (random key, `recoverable: false`)
is the safety net for whatever fraction of devices do not support it, and nothing in this
change requires that fraction to be known in advance. `docs/MAINNET_READINESS.md` records
this precisely rather than rounding it up to "done".
