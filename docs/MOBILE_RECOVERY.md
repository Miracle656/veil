# Mobile recovery & migration — how "your passkey is your account" works

_Last updated: 2026-08-21. Implemented in `frontend/mobile` (commit 8ce5bdb)._

## The model

A Veil mobile wallet is three linked facts:

| Fact | What it is | How it's recovered |
|---|---|---|
| **Passkey** (P-256) | The credential in the platform authenticator; authorises everything | Syncs with Google Password Manager / iCloud Keychain |
| **Fee-payer** (G…) | ed25519 account **deterministically derived from the passkey's PRF output** (salt `invisible-wallet/prf/feepayer/v1`); holds classic funds, pays fees | Re-derived from the passkey on any device |
| **Smart wallet** (C…) | Soroban contract whose address = f(passkey public key, factory); `__check_auth` verifies passkey signatures | Read from on-chain **breadcrumbs** (below) |

**Breadcrumbs**: at creation, the app writes manage-data entries on the fee-payer
account — `veil:wallet` (the C-address) and `veil:pk1`/`veil:pk2` (the 64-byte
uncompressed passkey public key, split). The fee-payer is derivable from the
passkey alone, so these entries make the whole wallet discoverable from just a
fingerprint. Serverless, seedless.

## Scenario 1 — same device, app reinstalled or storage cleared

Welcome → **I already have a wallet** → **Sign in with passkey**.
The wallet is usually still in the OS keychain (survives reinstall on Android
via keystore, not always — so the flow falls through): local fast-path returns
instantly; otherwise one passkey prompt runs the full recovery below. Either
way: **no stress, one tap.**

## Scenario 2 — new phone (migration)

Preconditions: the passkey synced to the new phone (Google Password Manager on
Android — on by default for platform passkeys; iCloud Keychain on iOS), and the
Veil app is installed.

1. **Sign in with passkey** → the platform sheet lists the synced Veil passkeys; pick one. **(one biometric)**
2. The same gesture returns the **PRF output** → the app re-derives the fee-payer keypair.
3. Horizon lookup of the fee-payer's data entries → C-address + passkey public key.
4. Everything is re-persisted (app secure store + SDK storage) — balances, send, swap, and `__check_auth` signing all work immediately.

What the user experiences: install app → tap "Sign in with passkey" → touch
sensor → wallet is back. That's the whole migration.

### Caveats
- **PRF must sync with the passkey.** Google Password Manager syncs hmac-secret/PRF for platform passkeys; a device-bound key (e.g. some security-key setups) won't produce the same PRF elsewhere → fall back to Scenario 3.
- Breadcrumbs are written best-effort at creation (needs the fee-payer funded). If they're missing, sign-in says so; re-creating them is a single manage-data transaction.

## Scenario 3 — passkey lost (phone gone, no sync)

Two independent fallbacks, both pre-existing:
- **SEP-30 recovery servers** (`app/recover.tsx`): servers registered while the wallet was healthy co-sign `request_recovery` for a fresh passkey; a time-delay window lets the real owner cancel. This is the credible answer for "phone in a river".
- **Paper backup** (`lib/backupFile.ts`): exported key material import.

## Spending model after login (who signs what)

- **Fee-payer funds** (classic G balance): fee-payer keypair signs; a passkey **presence gate** (fresh-challenge assertion) is demanded first whenever a passkey is registered.
- **Contract funds** (C-address balance): native-SAC `transfer(from=C…)` with the passkey signing the Soroban authorization preimage; the wallet contract's `__check_auth` verifies the WebAuthn signature **on-chain**. The Send flow auto-routes here when the fee-payer can't cover the amount but the contract can.

## Known limits / next steps
- USDC held *by the contract* isn't spendable yet (only native XLM has the contract-spend path).
- `login()` in the SDK is storage-bound; the mobile breadcrumb flow supersedes it for fresh devices — worth upstreaming into the SDK.
- Breadcrumb writes should be retried from Settings when they failed at creation (not yet surfaced in UI).
