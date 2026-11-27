# 2026-11-14: a spending account lost with an uninstall

**Loss:** 31.07 USDC and 7.88 XLM, one user. Not recoverable.
**Cause:** a defect in the Android app.
**Status:** cause fixed in code on 2026-11-14. The fix is not in a released
build yet.

## What happened

A user created a mainnet wallet in the Android app on 12 September 2026. A
Veil wallet has two accounts: the smart wallet, signed by the passkey, and a
classic spending account that pays network fees and is the address shown on
the Receive screen.

The app tries to derive the spending account's key from the passkey (a
WebAuthn PRF value), so the same passkey rebuilds it on any phone. When the
passkey returned no PRF value at creation, the app fell back to a random key
stored only in that phone's keychain. That happened here.

The user was paid in USDC at that address and used it normally until
11 November. They then uninstalled the app, which erased the keychain. Two
further payments, 16 USDC and 15 USDC, arrived at the address after the key
had last been used.

After reinstalling, the passkey still worked and matched the wallet's signer.
It derived three possible spending accounts. None was the funded one, and
none existed on the network. The random key was the only key, and it was gone.

## What the app got wrong

1. **It created an unrecoverable account without saying so** anywhere the user
   would see. The only notice was on a settings screen.
2. **Receive presented that account as the address to give an employer.**
3. **There was no way to save the key.** The key export refused every smart
   wallet, and the encrypted backup never contains a private key.
4. **A wallet on a random key was never moved** to a passkey-derived account,
   even after the passkey began returning PRF values.
5. **The manual repair would have made it worse.** It moved XLM only and then
   overwrote the stored key, which would have stranded the USDC by itself.
6. **The web recovery page refused wallets made in the mobile app**, so the
   one other route to the spending account was closed until that was removed.

## What we got wrong in the response

- We first told the user the funds were recoverable, reasoning from the date
  the wallet was created. That was wrong. The derived addresses should have
  been compared against the funded one before saying anything.
- Wallet creation had been broken for new users in five consecutive builds,
  and the website had been serving an old build, during the same week. Both
  delayed getting this user onto a working app.

## What changed

| Change | Where |
|---|---|
| A key switch moves every asset in one all-or-nothing transaction | `frontend/mobile/lib/feePayerMove.ts` |
| The replaced key is kept in secure storage, and the switch is refused if it cannot be | `retireFeePayerSecret` in `frontend/mobile/lib/walletStore.ts` |
| A warning on the dashboard and Receive while the spending account is on a random key | `frontend/mobile/components/SpendingAccountWarning.tsx` |
| The key of a random spending account can be shown, behind the device lock | `frontend/mobile/lib/spendingKeyExport.ts` |
| The sign-in sweep carries other assets, and never moves funds into a random-key account | `frontend/mobile/lib/feePayerSweep.ts`, `frontend/mobile/lib/passkeyLogin.ts` |
| The web recovery page accepts wallets made in the mobile app | `frontend/wallet/app/recover/page.tsx` |
| Written rules for keys and balances | `docs/policies/USER_FUNDS.md` |

Closing the old account's trustlines during a move is deliberate: a later USDC
payment to that address is rejected and stays with the sender.

## Still open

- The fix is not in a released build. Until it is, every wallet on a random
  key is exposed exactly as this one was.
- We do not know how many wallets are on a random key. Nothing reports it.
- A phone whose passkey manager never returns a PRF value cannot be moved. Its
  user can now save the key, and has to choose to.
- The move was tested against this account's figures in unit tests. It has not
  been run against the network or on a device.
- Reimbursement of this user is the project owner's decision and is recorded
  here once made.
