# Wave batch 15 — Getting back in on a new device (DRAFT)

**Source:** a tester on an Itel device, 2026-09-23, whose passkey manager does not implement the WebAuthn PRF extension. **Repo:** `Miracle656/veil`. **IDs:** V191–V197 (batch 14 ended at V190). **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** create the `epic:recovery` label.

## The hole this batch closes

Veil's smart wallet lives at a `C…` contract address derived from a passkey's public key. The passkey authorises spending through `__check_auth`. A separate `G…` account pays the fees, because a contract cannot pay its own gas.

That fee-payer is derived from the passkey's **PRF extension** output, which is what makes it re-derivable on a second device. Sign-in leans on this entirely — `lib/passkeyLogin.ts` asks for a discoverable passkey *with* PRF, derives the fee-payer from the result, and then reads on-chain breadcrumbs from that account to learn which `C…` address the passkey owns:

```ts
const picked = await discoverWithPrf(FEE_PAYER_PRF_SALT);
if (!picked) throw new Error('Passkey sign-in was cancelled.');
if (!picked.prf || picked.prf.length < 32) { throw new Error(…) }
```

**Some password managers never implement PRF.** On those, that throw is the end of the road: the user's passkey is intact, the wallet is intact, the signer is registered on the contract — and there is no way back in, because the app only knows how to *discover* a wallet through PRF.

Creation now warns about this and offers repairs (`recreatePasskeyWallet`, plus the encrypted backup). This batch is the other half: a way home for someone who is already in that state, and who is standing in front of a new phone.

## What actually has to be true

Recovery needs three things, and they are worth stating because two of them are often confused:

1. **The address.** Discovery is the only thing PRF was providing. An address the user supplies — typed, or read out of their backup file — replaces it completely.
2. **The passkey, on the new device.** This is the part no code can route around: `__check_auth` verifies against the signer set stored in the contract. If the manager is device-bound and the credential did not sync, the passkey is gone, and the only path is the SEP-30 recovery servers already built at `app/recover.tsx`. Say so plainly rather than implying the address is enough.
3. **Gas.** A recovered wallet's fee-payer is a fresh random `G…` with no XLM, so the user can see their balance and sign, but cannot submit until a little XLM lands there. Do not hide this.

## Ground rules for every issue here

- **Never trust a typed address.** `get_signers` simulates for free and settles it; a wallet whose signer set does not contain the user's passkey is not their wallet, and must not be loaded.
- **Never call the SDK's `register()` from a recovery or settings screen** — it overwrites `invisible_wallet_key_id` / `_address` / `_public_key` and strands the wallet being recovered.
- **Do not claim a wallet is unrecoverable when it is not.** A no-PRF wallet loses the fee-payer float, not the wallet: the encrypted backup carries the `C…` address and the passkey public key, which is exactly what a fresh device needs.
- **No screen may tell the user to change a device setting** to finish onboarding or recovery.
- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.

---

### V191 · Sign in on a new device by wallet address

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:recovery

### Background
`app/login.tsx` offers exactly one action, "Sign in with passkey", and it hard-depends on PRF (see the throw quoted above). A user whose manager has no PRF cannot get back into a wallet they still fully control.

The address is the only thing PRF was supplying. Let the user supply it instead.

### What to build
- A second entry point on the sign-in screen: "I know my wallet address", taking a `C…` address.
- Resolve it before trusting it: `readSigners(address)` from `lib/signers.ts` simulates `get_signers` and costs nothing. Distinguish "not a deployed wallet" from "the network is unreachable" — do not report the second as the first.
- Ask for a passkey assertion, and confirm the credential's public key is present in the signer set. A mismatch must refuse and explain, never load the wallet read-only.
- On success, persist address and passkey through `walletStore`, derive the fee-payer from PRF when it is available and fall back to a fresh random key when it is not, and write breadcrumbs so the next device has the easy path.

### Key files
- `frontend/mobile/app/login.tsx`, `frontend/mobile/lib/passkeyLogin.ts`
- `frontend/mobile/lib/signers.ts` (already simulates `get_signers`), `frontend/mobile/lib/walletStore.ts`

### Acceptance criteria
- [ ] A valid address whose signer set contains the user's passkey signs in with no PRF anywhere in the path
- [ ] An address that is not a deployed wallet, and an unreachable network, produce different messages
- [ ] A passkey that is not in the signer set is refused, and no wallet state is written
- [ ] Malformed input is rejected before any network call
- [ ] Tests cover all four outcomes

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V192 · Sign in from a backup file, with nothing to type

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:recovery

### Background
The encrypted backup already holds the `C…` address and the passkey public key (`WalletBackupMetadata` in `lib/backup.ts`), and `restoreFromFile` already decrypts and persists it. Today that only exists inside Settings → Wallet backup, which a user on a **new phone cannot reach**, because they are not signed in.

A 56-character address read off another screen is also the worst possible thing to ask someone to retype.

### What to build
- A "Restore from a backup file" action on the sign-in screen, reusing `pickBackupFile` / `readBackupFile` / `restoreFromFile`.
- After decryption, run the same signer check V191 introduces: the passkey on this device must be in the restored wallet's on-chain signer set. A backup proves what the wallet *was*, not that this device can sign for it.
- Land on the dashboard signed in, not back at the welcome screen.

### Key files
- `frontend/mobile/app/login.tsx`, `frontend/mobile/lib/backupFile.ts`
- `frontend/mobile/app/settings/backup.tsx` (share the restore panel rather than copying it)

### Acceptance criteria
- [ ] Restore is reachable without being signed in
- [ ] A wrong passphrase or altered file leaves existing device state untouched (`BackupTamperError`)
- [ ] A backup whose wallet does not list this device's passkey is refused with a message that names the SEP-30 path
- [ ] The restore panel exists once and is used by both screens

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V193 · Say when the fee-payer is empty, and what to do about it

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy, epic:recovery

### Background
A wallet recovered without PRF gets a **fresh random fee-payer holding zero XLM**. The balance loads, the passkey signs, and then every submission fails — because a Soroban contract cannot pay its own gas, and the account paying it has nothing.

Failing at submission time, with a network error, is the worst place to discover this.

### What to build
- After recovery, check the fee-payer account. When it does not exist or holds less than the reserve plus a small fee buffer, show a persistent, dismissable banner on the dashboard.
- Say the amount, show the `G…` address with a copy button and a QR code, and explain in one line that this account pays network fees and is not the wallet balance.
- Re-check when the dashboard refreshes, and remove the banner once funded.

### Key files
- `frontend/mobile/app/(tabs)/dashboard.tsx`, `frontend/mobile/components/` (new banner)
- `frontend/mobile/lib/fees.ts`

### Acceptance criteria
- [ ] A missing account and a funded-but-too-low account both raise the banner; a healthy one does not
- [ ] The banner names a concrete amount, not "some XLM"
- [ ] The address shown is the fee-payer, never the `C…` wallet address
- [ ] It clears without an app restart once funded
- [ ] Unit tests cover the three balance states

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V194 · Ask whether the passkey can do PRF before creating the wallet

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:recovery

### Background
`createPasskeyWallet` registers the passkey, *then* evaluates PRF, and only then can it tell the user that the wallet it just made is not re-derivable. The user meets the problem after the fact, holding a wallet they are being advised to replace.

The order is backwards. The check is cheap and can happen first.

### What to build
- Before the create flow commits, determine whether the platform's chosen manager returns a PRF result, and show what that means in plain language *while the choice is still open*.
- When it cannot, offer the same two exits creation now offers afterwards — a different passkey, or a recovery file — as a choice up front rather than a warning after.
- Do not block creation. A user who understands the trade-off and wants to continue may.

### Key files
- `frontend/mobile/app/create-wallet.tsx`, `frontend/mobile/lib/passkeyWallet.ts`
- `frontend/mobile/lib/passkey.ts` (`evaluatePrf`), `frontend/mobile/lib/prfOutcome.ts`

### Acceptance criteria
- [ ] A manager without PRF is surfaced before the wallet is presented as ready
- [ ] The user can still continue deliberately, and the resulting wallet is marked exactly as it is today
- [ ] No extra passkey prompt is added for users whose manager does support PRF
- [ ] No copy anywhere in the flow instructs the user to change a device setting
- [ ] Tests cover the PRF and no-PRF branches

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V195 · A recovery status card in Settings

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate, epic:recovery

### Background
Whether a wallet can survive the loss of its phone depends on three independent things — a PRF-derived fee-payer, a saved backup file, and configured SEP-30 recovery servers — and the app currently shows the first one exactly once, on the creation screen, and then never again.

Users cannot check the thing that matters most on the day it matters.

### What to build
- A card in Settings answering "could I get this wallet back?", with a row per mechanism, each either satisfied or carrying the one action that satisfies it.
- Derive the state rather than storing a flag: compare the stored signer secret against the PRF-derived key, record when a backup was last exported, read the configured recovery servers.
- An overall line at the top that is honest about partial cover — one mechanism is not the same as three.

### Key files
- `frontend/mobile/app/settings/` (new screen), `frontend/mobile/lib/passkeyWallet.ts`
- `frontend/mobile/lib/backupFile.ts`, `frontend/mobile/lib/recovery.ts`

### Acceptance criteria
- [ ] Each row reflects real device and chain state, not a stored boolean
- [ ] Checking PRF status does not silently trigger a passkey prompt on screen open
- [ ] Every unsatisfied row links to the screen that fixes it
- [ ] The summary does not report a wallet as covered when only one mechanism is present
- [ ] Unit tests cover the state combinations

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V196 · The same address-based sign-in on the web wallet

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:recovery

### Background
The web wallet discovers a wallet the same PRF-dependent way, so it has the same hole. A user who recovers on their phone and then opens the web wallet should not hit a second dead end.

Depends on V191 — take the verification rule from it rather than inventing a second one.

### What to build
- Address entry and backup-file restore on the web sign-in path, with the same `get_signers` verification and the same refusal when the passkey is not a registered signer.
- Share the verification logic with mobile rather than reimplementing it; the two must not disagree about what counts as a valid recovery.

### Key files
- `frontend/wallet/app/` (sign-in path), `sdk/src/`

### Acceptance criteria
- [ ] Web recovers a wallet with no PRF anywhere in the path
- [ ] Web and mobile accept and refuse exactly the same cases, proven by tests over a shared table
- [ ] The web fee-payer state is surfaced the way V193 surfaces it on mobile

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V197 · Prove new-device recovery end to end

**Labels:** help wanted, Stellar Wave, area:mobile, area:testing, difficulty:advanced, epic:recovery

### Background
Every issue in this batch is about a path that only runs on the worst day the user will have with this app, on a device the developer does not have. That is exactly the kind of path that rots silently — the PRF hole itself survived because nothing exercised sign-in without PRF.

### What to build
- An automated test that walks the whole thing against testnet: create a wallet, clear all device state as a new phone would present it, recover by address, and submit a transaction that `__check_auth` accepts.
- Run it with PRF available and with PRF unavailable, by substituting the evaluator rather than by mutating global state.
- Assert on the fee-payer gap too: the no-PRF run must reach a signed transaction that fails for want of gas, then succeed once the fee-payer is funded. That ordering is the contract this batch relies on.

### Key files
- `frontend/mobile/lib/__tests__/` (new), `frontend/mobile/lib/passkeyLogin.ts`
- `.github/workflows/mobile.yml`

### Acceptance criteria
- [ ] Both runs pass from clean device state with no manual step
- [ ] The no-PRF run recovers the same `C…` address the PRF run created
- [ ] The gas-gap assertion is explicit, not incidental
- [ ] It runs in CI, and a deliberate regression in `passkeyLogin.ts` turns it red

> **Drips Wave** · Complexity: **Advanced** · **200 points**
