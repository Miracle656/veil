# User funds

Rules for any code that creates, stores, replaces or uses a key that controls
a user's money. Each rule is here because breaking it cost a user money or
access. A change that breaks one needs a reason written in the pull request
and a second person's approval.

## 1. No key that holds money may exist in only one place without the user knowing

If a key cannot be rebuilt from the user's passkey, the user must be told, in
plain words, on the screens where that account is used: the dashboard and
Receive. A settings page is not enough.

The warning stays until the risk is gone. It is not dismissible.

*Why:* a spending account was put on a random key when a passkey returned no
PRF value. The only notice was three taps deep in settings. The user was paid
into that account, uninstalled the app, and lost 31.07 USDC.

*In the code:* `lib/spendingAccountWarning.ts`, `components/SpendingAccountWarning.tsx`.

## 2. Every key that holds money has a way off the phone

Either the passkey rebuilds it, or the user can save it. There is no third
case. If the passkey cannot rebuild a key, the app must offer to show it,
behind the device lock.

The encrypted backup does not count. It never contains a private key, and no
screen may suggest it protects an account whose key it does not hold.

*In the code:* `lib/spendingKeyExport.ts`, `lib/secretExport.ts`.

## 3. Never replace a key before everything it controls has moved

A switch from one spending key to another must, in this order:

1. move every asset the old account holds, not XLM alone, in one transaction
   that applies completely or not at all;
2. keep the old key in secure storage, and confirm it was written;
3. only then store the new key.

If step 1 or 2 fails, nothing changes. An account that cannot be moved
completely is not moved at all.

*Why:* the repair for a random key moved the XLM and then overwrote the stored
secret. USDC on the old account would have been lost by the repair itself.

*In the code:* `lib/feePayerMove.ts`, `retireFeePayerSecret` in
`lib/walletStore.ts`, `retryRecoveryBinding` in `lib/passkeyWallet.ts`.

## 4. Money only moves toward the more recoverable account

A balance may be moved from an account that lives on one phone to one the
passkey can rebuild. Never the other way, and never automatically into a
random-key account.

## 5. Unknown is not "no"

When a check about money cannot be completed (a network call fails, storage
does not answer), the code takes the path that changes nothing. "Could not
load the account" is never read as "the account is empty", and "could not ask
the chain" is never read as "nothing is held there".

## 6. A limit on signing is not a reason to lock someone out

If a wallet cannot sign in some place (a wallet made in the mobile app cannot
sign for its contract on the web), say so at the moment the user tries that
action. Do not refuse the sign-in, the unlock or the recovery. The user can
still read balances, and may hold funds that place can sign for.

*Why:* this was shipped as a gate twice. It locked one user out of their own
wallet on the lock screen, and on 2026-11-14 it stood between another user and
the only screen that could have reached their spending account.

## 7. An address shown to a user is never shortened in anything they will act on

Issue text, support replies and error messages give addresses and contract
ids in full. A shortened address has been copied as if it were whole.

## 8. Money-moving code is tested with the real numbers

A change to code that moves funds carries a test built from an actual account:
its balances, its subentries, its reserve. If the change follows an incident,
the test uses that incident's figures.

## What these rules do not cover yet

- Collectibles and names held by a spending account are not moved by a key
  switch. The switch is refused while a Veil-ian is held there.
- The reserve left on a retired spending account (about 2 XLM) stays there.
  Its key is kept on the phone and is lost with the phone.
- None of this helps a wallet whose key is already gone.
