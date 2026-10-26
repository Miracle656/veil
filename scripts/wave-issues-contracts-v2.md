# Wave batch — the smart wallet nobody can reach (V317–V336)

Drafted 2026-10-21 by reading `Miracle656/veil` at `main`, the deployed
contracts, and `docs/CONTRACTS_V2.md`. Checked against all 119 open veil issues
first; nothing here duplicates one. Four candidates were dropped during that
check because they already exist — #1040 (swap platform fee), #1072
(stellar.toml for names), #735 (Invest section), #1078 (name ↔ Masquerade).

Two things shaped this batch.

**The contracts are the least-covered area in the repo.** Three open issues
against 41 for mobile and 28 for the wallet — while the mainnet factory and
every wallet deployed from it are **permanent**, because neither contract has
an upgrade entry point. `docs/CONTRACTS_V2.md` is a careful, maintainer-written
account of what that means and what v2 needs. Most of it has never been turned
into work anyone can pick up.

**The wallet already has features nothing calls.** Session keys, per-key spend
limits and guardian recovery are deployed on mainnet today. Neither client has
a single call site for any of them. That is a moat we are not using, and it is
also the part of the wallet with the least testing, because nothing exercises
it.

## Shared with every issue

**Repo:** `Miracle656/veil`. Contracts are `contracts/` (Rust / Soroban), mobile
is `frontend/mobile` (Expo / React Native), the web wallet is `frontend/wallet`
(Next.js). The backend is the sibling repo `Miracle656/wraith`.

**Run the tests:** `cargo test` in `contracts/`, `npm test` in
`frontend/mobile` (jest via jest-expo) or `frontend/wallet`. **Install with
plain `npm install` in `frontend/mobile`** — never `--legacy-peer-deps`, which
corrupts that lockfile.

**The deployed contracts cannot be changed.** There is no `upgrade`, no
`update_current_contract_wasm`, and the factory exposes only `__constructor`,
`init` and `deploy`. Anything that ships as a contract change is a **new
factory at a new address**, and existing wallets keep running the code they
were deployed with. Design accordingly, and say in your PR what it means for a
wallet that already holds money.

**A contract change means the WASM hash changes.** Update
`contracts/expected-hashes.json` from the CI log in the same PR, or the
reproducible-build check fails for everyone after you.

**This wallet holds real money on mainnet.** A wallet's keys are derived from a
passkey; losing or mis-deriving them loses the funds. Never weaken a test to
make a signing path pass.

**Never elide an address, a contract id or a key** in code, comments or test
fixtures. A previous batch shortened a contract id in an issue text and five
contributors invented their own to fill the gap. Write them in full or do not
write them at all.

---

### V317 · The 24-hour spend limit does not know what it is counting

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:advanced

### Background

The per-key spend limit takes a key and a number, and nothing else:

```rust
// contracts/invisible_wallet/src/lib.rs
pub fn set_key_spend_limit(env: Env, key_id: BytesN<65>, cap: i128)
```

and enforcement sums whatever moved:

```rust
policies::spend_limit::enforce(&env, &public_key, total_amount)?;
```

So a cap of `100` means a hundred XLM, or a hundred USDC, or a hundred of any
asset the wallet holds — and those are wildly different amounts of money. A
limit set with XLM in mind permits several times that value the moment the user
holds a stablecoin.

Note that the wallet already keys *allowances* per `(spender, token)` in
`storage.rs`, so the per-token shape exists in this codebase. The spend limit
simply does not use it.

### What to build

- Key the limit per `(key_id, token contract)`, in the shape
  `docs/CONTRACTS_V2.md` §6 describes.
- Decide deliberately what an unset token means — no limit, or denied — and
  write the reasoning in the code, not just the PR.
- Keep the existing 24-hour rolling window behaviour.

### Acceptance criteria

- [ ] A limit applies to one token, not to any asset
- [ ] A limit on one token does not restrict another
- [ ] The 24-hour window still rolls as it does today
- [ ] A test proves a cap set in XLM does not permit the same number in USDC
- [ ] `contracts/expected-hashes.json` is updated from the CI log
- [ ] The PR states what happens to wallets already deployed with the old limit

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V318 · A wallet cannot be upgraded, and that should be a decision rather than an accident

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:advanced

### Background

`docs/CONTRACTS_V2.md` §6 asks for `upgrade(new_wasm_hash)` on the wallet,
**authorised only by that wallet's own signers**. The emphasis is the whole
design: an operator who can upgrade a user's wallet can take its funds, so the
authority must come from the same `__check_auth` ceremony that authorises a
spend.

Today there is no upgrade path at all, which is a defensible position — and it
is not the one the public documentation describes, nor one anyone chose. Issue
#1147 reports that mismatch; this issue is one of the two possible answers to
it. The other is to correct the documentation. If you think the docs should
change instead, say so on #1147 rather than building this.

### What to build

- `upgrade(new_wasm_hash)` on the wallet, authorised through the wallet's own
  signer set and nothing else.
- A test that an operator key, a guardian, and the factory admin each **cannot**
  upgrade a wallet. `docs/CONTRACTS_V2.md` names this test explicitly, and it
  is the one that matters.
- Think about what happens to a session key: should a limited-scope key be able
  to replace the entire contract? Argue the answer in the PR.

### Acceptance criteria

- [ ] Only the wallet's own signers can upgrade it
- [ ] Tests prove an operator key, a guardian and the factory admin cannot
- [ ] The interaction with session keys and spend limits is decided and tested
- [ ] `expected-hashes.json` updated from the CI log
- [ ] The PR states that this affects new wallets only

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V319 · The factory's WASM hash is fixed at deploy, so v2 means a new address

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:advanced

### Background

`contracts/factory/src/lib.rs` exposes exactly `__constructor`, `init` and
`deploy`. `set_wasm_hash` exists in `storage.rs` as an internal helper and is
not reachable from outside.

So the factory deploys one wallet implementation forever. Shipping a better
wallet means a new factory at a new address, and every client's default factory
id has to change — which is exactly the migration `docs/CONTRACTS_V2.md` §6
wants to avoid repeating. Related: #1147, which reports that the public
documentation already claims this exists.

### What to build

- An admin-gated `set_wasm_hash(new_hash)` on the factory. The admin is already
  fixed at construction, so the gate exists; it is the entry point that does not.
- Be explicit about what it does **not** do: changing the hash must not touch a
  single already-deployed wallet. Only future deployments.
- A test that a non-admin cannot call it.

### Acceptance criteria

- [ ] `set_wasm_hash` is callable by the admin and nobody else
- [ ] Existing deployed wallets are provably unaffected
- [ ] A wallet deployed after the change uses the new hash
- [ ] `expected-hashes.json` updated from the CI log
- [ ] The PR explains the relationship to counterfactual addresses

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V320 · An allowance can be granted and never taken back

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:advanced

### Background

A wallet can grant a spender a standing allowance on a token, and that
allowance is real — `__check_auth` Branch 1 looks it up, checks its expiry,
and debits it:

```rust
allowance.amount -= amount;
env.storage().persistent().set(&key, &allowance);
```

So it is a live authority to move the wallet's money, not a decorative record.

There is no way to withdraw it.

`approve` is the only writer, and it refuses to store a zero:

```rust
if amount <= 0 {
    panic!("Amount must be greater than 0");
}
```

There is no `revoke_allowance` entry point — note that session keys *do* have
one, `revoke_session_key`, so the asymmetry is an omission rather than a
decision. And `expiry` is `Option<u64>`, where `None` means no expiry at all.

Put together: an allowance granted with no expiry is permanent. The owner can
lower it by approving a smaller positive amount, but can never reach zero and
can never remove it. A dApp that was trusted once holds that authority for as
long as the wallet exists.

### What to build

- A revoke path. Either a `revoke_allowance(spender, token)` entry point, or
  make `approve` with `amount = 0` mean revoke instead of panicking — and if
  you keep the panic, the code must say why.
- Decide what an absent expiry should mean for new allowances. A default
  expiry changes the risk profile of this feature substantially; argue it.
- A test that a revoked allowance is rejected by `__check_auth`, not merely
  absent from storage.

The panic is worth a second thought on its own: a panic in a contract entry
point gives the caller no typed error, and this one fires on an input a client
would reasonably send.

### Acceptance criteria

- [ ] An allowance can be reduced to zero or removed outright
- [ ] A revoked allowance is provably rejected at the authorisation boundary
- [ ] `approve` no longer panics on an amount a client might legitimately send
- [ ] What `expiry: None` means is decided and documented
- [ ] `contracts/expected-hashes.json` updated from the CI log
- [ ] The PR states that wallets already deployed keep the current behaviour,
      and what their owners should be told

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V321 · Session keys are deployed and nothing has ever called them

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

The mainnet wallet contract supports additional signer keys — `add_signer`,
`remove_signer`, `rotate_signer`, `get_signers` — and per-key spend limits.
Neither client calls any of them.

So the feature is deployed, costs nothing more to use, and is invisible. It is
also the least-tested part of the contract, because nothing exercises it.

### What to build

- A screen that lists the wallet's signers and lets the user add and remove one.
- Show what each key can do, including its spend limit if set.
- Removing the last signer must be impossible, and the UI must say why rather
  than failing at the contract.

### Acceptance criteria

- [ ] Signers can be listed, added and removed from the app
- [ ] Each signer's spend limit is visible where one is set
- [ ] Removing the only signer is prevented in the UI, with a reason
- [ ] A removed key provably cannot sign afterwards
- [ ] Tests cover add, remove and the last-signer guard

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V322 · Guardian recovery exists on-chain and nowhere in the app

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

`set_guardian`, `initiate_recovery` and `complete_recovery` are deployed. No
client calls them.

Recovery is the single most important thing a self-custodial wallet can offer,
and the only reason a cautious person would trust one. We have it and never
mention it.

This matters particularly for passkey providers with no PRF support, where a
wallet can otherwise become unrecoverable — a real case recorded in
`docs/CONTRACTS_V2.md` §8.

Distinct from #1050 and #770, which cover recovering a key on a new device.
This is the on-chain guardian mechanism, which is a different thing: a third
party you nominate, not a key you still hold.

### What to build

- Let a user nominate a guardian, see who it is, and change it.
- The recovery flow itself: initiate, show the waiting period honestly, complete.
  Note the delay is 3 days on the guardian path. Read V330 before you start —
  there is a second, separate recovery mechanism with a 7-day delay, and a UI
  that silently drives only one of them would be misleading.
- Be explicit about what a guardian can and cannot do. A user who does not
  understand the trust they are granting has not consented to it.

### Acceptance criteria

- [ ] A guardian can be set, viewed and changed from the app
- [ ] Initiate and complete are both reachable, with the delay shown
- [ ] The UI states plainly what a guardian is able to do
- [ ] A pending recovery is visible to the wallet owner
- [ ] Tests cover set, initiate, complete and cancel

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V323 · Nothing proves an operator cannot move a user's money

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:intermediate

### Background

The wallet's security rests on one claim: only the passkey holder can authorise
a spend. The fee-payer key, the factory admin and any future guardian must not
be able to, in any combination.

`docs/CONTRACTS_V2.md` §6 asks for exactly this test and it does not exist as a
named suite.

A test that proves what an attacker **cannot** do is worth more than several
that prove the happy path works, and it is the kind of test that only gets
written deliberately.

### What to build

- A suite whose subject is refusal: for each privileged role we actually have,
  assert it cannot spend, cannot add a signer, and cannot recover.
- Include combinations — a fee payer plus a guardian is still not the user.
- Name the suite so its purpose is obvious to someone reading the test list.

### Acceptance criteria

- [ ] Every privileged role is proven unable to spend
- [ ] Each is proven unable to add or rotate a signer
- [ ] Combinations of roles are covered, not only single roles
- [ ] Each test states, in a comment, what would be lost if it failed

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V324 · Adding a signer after removing one overwrites a key

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:advanced

### Background

Signers live in a `Map<u32, BytesN<65>>` keyed by index. New ones are appended
using the map's length as the next index:

```rust
// storage.rs
pub fn add_signer(env: &Env, key: &BytesN<65>) -> u32 {
    let mut signers = get_signers(env);
    let next_index = signers.len();
    signers.set(next_index, key.clone());
    ...
}
```

and removal deletes the entry without renumbering what is left:

```rust
pub fn remove_signer(env: &Env, index: u32) -> bool {
    let mut signers = get_signers(env);
    if signers.contains_key(index) {
        signers.remove(index);
        ...
```

So length stops tracking the highest index as soon as anything is removed from
the middle. With signers at 0, 1 and 2, removing index 1 leaves `{0, 2}` with a
length of 2 — and the next `add_signer` computes `next_index = 2` and calls
`signers.set(2, new_key)`, **overwriting the existing signer at index 2**.

The key at that index loses access to the wallet. There is no error, no event,
and nothing in `get_signers` afterwards hints that a key was displaced rather
than added. For a wallet that has had a device rotated out, adding a new device
can silently lock out one that was working.

Note also that `add_signer` has no duplicate check, while `rotate_signer`
deliberately guards against one with `has_signer` — the same asymmetry.

### What to build

- Make index allocation independent of the map's length. Decide between
  tracking the next index in its own storage slot and renumbering on removal,
  and say in the code which you chose and why — they behave differently for a
  client that has cached an index.
- Reject adding a key that is already a signer, as `rotate_signer` does.
- Tests: add three, remove the middle one, add a fourth, and assert the
  original three keys that should still work all still authorise.

Think about what `signer_count` should mean once indices are sparse. It is used
by the last-signer guard in `remove_signer`, so getting it wrong there has its
own consequences.

### Acceptance criteria

- [ ] Adding a signer after a middle removal never overwrites an existing one
- [ ] A displaced key is impossible, proven by a test that authorises with each
      remaining key afterwards
- [ ] Adding a key that is already registered is rejected
- [ ] The last-signer guard still holds with sparse indices
- [ ] `contracts/expected-hashes.json` updated from the CI log
- [ ] The PR says what this means for the wallets already deployed

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V325 · Recovery breadcrumbs have never been confirmed on mainnet

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

`docs/CONTRACTS_V2.md` §8 lists "confirm recovery breadcrumbs are written on
mainnet (two data entries on the account)" as open.

Recovery depends on those entries existing. If they are not written, recovery
fails at exactly the moment it is needed, and nobody finds out until then.

### What to build

- A check that the expected data entries exist on an account after wallet
  creation, runnable against a real network.
- Assert their shape, not merely their presence. An entry with the wrong
  contents is as useless as a missing one.
- Make it runnable on testnet in CI, and on mainnet deliberately.

### Acceptance criteria

- [ ] Both data entries are asserted by name and shape
- [ ] The check runs on testnet without manual steps
- [ ] It can be pointed at mainnet explicitly
- [ ] A missing or malformed entry fails loudly
- [ ] No secret key appears in the test or its output

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V326 · There is no way to tell whether a passkey can be recovered

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

Some passkey providers return no PRF result — Samsung Pass and a vivo device
are recorded in `docs/CONTRACTS_V2.md` §8. A wallet created on one of those
derives its fee payer differently and can end up unrecoverable.

The create screen now explains this and offers a retry while the account is
still unfunded, which is the hard part and is done. What is missing is
afterwards: a user who already has a wallet has no way to find out which kind
they have.

### What to build

- Surface, somewhere in settings, whether this wallet's keys are PRF-derived.
  Issue #767 covers asking *before* creation; this is the same question for a
  wallet that already exists, so coordinate rather than duplicating it.
- Say what it means in consequences, not mechanism: what still works, what does
  not, and what to do about it.
- If the wallet can be repaired in place, link to that flow.

### Acceptance criteria

- [ ] A user can discover whether their wallet is PRF-backed
- [ ] The explanation is in terms of what they can and cannot do
- [ ] A repair path is offered where one exists
- [ ] No key material is displayed
- [ ] Tests cover PRF and non-PRF states

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V327 · Multi-wallet is undecided, and the salt scheme has to be chosen before anyone ships one

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:advanced

### Background

`docs/CONTRACTS_V2.md` §6 leaves multi-wallet open, with a proposed salt of
`SHA-256(public_key ‖ index)` and index 0 reproducing today's address.

That last property is the load-bearing one: whatever is chosen, an existing
user's current wallet must keep its address. Getting this wrong after people
hold money is not recoverable.

### What to build

- A written decision — in `docs/`, as an ADR — covering the salt scheme, how
  index 0 stays compatible, and what a client does with several wallets.
- If the answer is "not now", that is a legitimate outcome: write down why, and
  what would change it.
- If it is yes, the factory change and tests proving index 0 is byte-identical
  to a wallet deployed today.

### Acceptance criteria

- [ ] A decision exists in `docs/` with its reasoning
- [ ] Index 0 provably yields the current address for an existing key
- [ ] The client-side implications are described
- [ ] If implemented, `expected-hashes.json` is updated from the CI log

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V328 · Nothing tells a user when their money arrives

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:advanced

### Background

`docs/CONTRACTS_V2.md` §8 lists instant notifications as open: an Expo push
token plus something watching mainnet.

Today a user who is sent money finds out by opening the app and looking. For a
wallet meant to be used like a bank account, that is the difference between a
tool and a toy.

### What to build

- Register a push token per wallet, with the user's consent and a way to revoke
  it.
- A sender that watches for payments to the wallet's addresses and pushes.
- Be careful what the notification says. An amount on a lock screen is a
  privacy decision, and this wallet's whole premise is privacy — make it a
  setting, and default it conservatively.

### Acceptance criteria

- [ ] A token is registered with consent and can be revoked
- [ ] An incoming payment produces a notification
- [ ] What the notification reveals is configurable and conservative by default
- [ ] No token or address is logged where it can be correlated to a person
- [ ] A revoked token stops receiving pushes

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V329 · The privacy pool has one open issue and the largest unknown

**Labels:** help wanted, Stellar Wave, area:privacy, difficulty:intermediate

### Background

On-chain privacy is the headline claim of this project and `area:privacy` has a
single open issue.

The integration is with Stellar Private Payments, whose published npm SDK is
**browser-only** — `Storage.open()` throws under Node — and is well behind the
deployed contracts. So anything that tests the real thing has to drive a
browser, and the version we pin has to be checked against what is deployed.

### What to build

- Pin the SPP version we integrate against, in one place, with the deployed
  contract ids beside it.
- A check that the pin still matches what is deployed, so drift is a failing
  test rather than a surprise.
- Document the browser-only constraint where someone will hit it, not only in a
  design note.

### Acceptance criteria

- [ ] The pinned version and the deployed contract ids live together
- [ ] Drift between them fails a check
- [ ] The Node limitation is documented at the point of use
- [ ] No contract id in the diff is shortened or elided

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V330 · A wallet has two recovery systems and they cannot see each other

**Labels:** help wanted, Stellar Wave, area:contracts, difficulty:advanced

### Background

The deployed wallet has **two independent ways to replace its signer**, added
at different times, and nothing connects them.

The guardian path, in `lib.rs`:

```
set_guardian(guardian)  ->  initiate_recovery(new_public_key)  ->  complete_recovery()
```

keyed on `DataKey::RecoveryPending`, with `RECOVERY_DELAY_SECONDS` of 3 days.

The recovery-key path, in `recovery.rs`:

```
set_recovery_key(key)  ->  request_recovery(new_signer)  ->  finalize_recovery()
```

keyed on `DataKey::RecoveryKeyPending`, with `RECOVERY_KEY_DELAY` of 7 days.

Three consequences follow, and all three are reachable on mainnet today.

**Both can be pending at the same time.** `initiate_recovery` refuses only if
`RecoveryPending` is set; `request_recovery` refuses only if
`RecoveryKeyPending` is set. Neither looks at the other. A wallet can therefore
have two different pending signer replacements racing two different timelocks.

**Cancelling is ambiguous.** `cancel_recovery` removes `RecoveryPending` and
`cancel_recovery_request` removes `RecoveryKeyPending` — each only its own. And
both paths return the *same* errors, `RecoveryAlreadyPending` and
`RecoveryNotPending`, so an owner who cancels a recovery they were alerted to
has no way to tell from the contract's response that a second one is still
counting down.

**Either one wipes every other signer.** Both `complete_recovery` and
`finalize_recovery` call `storage::init_signers`, which does not merge — it
builds a fresh map holding exactly one key at index 0. Every added signer and
every session key disappears. For a wallet that has been set up with additional
keys, recovery is also a silent reset of its entire authorisation state.

### What to build

This is a design question first and code second, so start by writing down which
of these mechanisms is the intended one. Both existing, half-wired, is not a
position anyone chose.

- Decide whether the wallet has one recovery path or two, and if two, what each
  is for.
- Make a pending recovery in either system visible to the other, so two cannot
  race.
- Make cancellation unambiguous — an owner cancelling should either cancel
  everything pending or be told precisely what remains.
- Distinguish the error codes so a caller can tell which system refused.
- Decide deliberately whether recovery should preserve other signers. If it
  should keep wiping them, say why in the code; if not, merge rather than reset.

Remember that deployed wallets keep the current behaviour whatever you do, so
the PR needs to say what an existing wallet's owner should be told.

### Acceptance criteria

- [ ] A written decision on one path versus two, with reasoning
- [ ] Two recoveries provably cannot be pending simultaneously
- [ ] Cancellation either clears all pending recoveries or reports what is left
- [ ] The two paths return distinguishable errors
- [ ] The effect on existing extra signers is deliberate and tested
- [ ] A test covers the race: initiate both, then finalise each
- [ ] `contracts/expected-hashes.json` updated from the CI log

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V331 · A passkey prompt the user dismisses looks like a failure

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy

### Background

Every spend goes through a passkey ceremony. A user can cancel one, or let it
time out, or be on a device whose authenticator refuses.

Those are three different things and none of them is an error in the usual
sense — the first is the user changing their mind. Treating a cancellation as a
failure is how an app teaches people that it is broken.

### What to build

- Distinguish, across the money screens: the user cancelled, the authenticator
  refused, and something genuinely failed.
- A cancellation returns to where the user was, with nothing alarming.
- The other two explain themselves and offer the next step.

### Acceptance criteria

- [ ] Cancellation is distinguished from failure on every spend path
- [ ] Cancelling leaves no error state and no partial transaction
- [ ] An authenticator refusal explains what to try
- [ ] Tests cover all three outcomes on at least two screens

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V332 · Losing the network mid-payment has no defined behaviour

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

There is an `offline.tsx` screen, so offline is a considered state at the app
level. What is not defined is losing connectivity **during** a money action —
after the passkey prompt and before confirmation.

That is the same class of problem the airtime screen solved with its
`unconfirmed` state: the user may already have been charged, so "failed" is a
claim we cannot support.

### What to build

- Define what each money screen does when the network drops mid-action.
- Reuse the `unconfirmed` pattern rather than inventing a second vocabulary:
  the person has possibly paid, and the screen must say exactly that.
- On reconnect, resolve it rather than leaving the user to guess.

### Acceptance criteria

- [ ] Every money screen has a defined mid-action disconnect behaviour
- [ ] No screen reports a failure it cannot prove
- [ ] Reconnecting resolves an unconfirmed action where possible
- [ ] Tests simulate a disconnect after the ceremony on at least two screens

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V333 · The contract test suite does not say what it is defending

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:easy

### Background

`cargo test` passes in `contracts/`, and from the test names alone it is hard
to tell which cases exist because of a real incident and which are routine.

The repository has a pattern worth extending: the comments that explain *why* a
check exists are the ones that stop someone deleting it later. The contract
tests mostly lack them.

### What to build

- For each contract test that guards a specific hazard, a one-line comment
  saying what breaks if it fails.
- Group the suite so a reader can see the shape: authorisation, limits,
  recovery, lifecycle.
- Do not change what any test asserts. This is about legibility.

### Acceptance criteria

- [ ] Hazard-guarding tests say what they guard
- [ ] The suite is grouped by concern
- [ ] No assertion is changed, weakened or removed
- [ ] `cargo test` still passes

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V334 · Nothing checks the deployed contracts are the ones we built

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate

### Background

`contracts/expected-hashes.json` records what a reproducible build produces,
and the repository verified byte-for-byte against mainnet once, by hand.

Nothing re-checks it. If the hashes file drifts from what is actually deployed
— or from what the current source builds — we would not know until someone
repeated the exercise manually.

### What to build

- A check that the hashes in `expected-hashes.json` match what the current
  source builds reproducibly.
- Separately, a check that the deployed mainnet factory's WASM hash is the one
  we expect. These are different questions and both matter.
- The second needs network access, so make it deliberate rather than part of
  every PR.

### Acceptance criteria

- [ ] A build-vs-expected check runs in CI
- [ ] A deployed-vs-expected check exists and can be run deliberately
- [ ] A mismatch fails with both hashes printed in full, never truncated
- [ ] The contract ids used are written in full

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V335 · A user cannot see what their wallet is allowed to do

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate

### Background

A wallet can hold token allowances — `approve`, `get_allowance`, keyed per
`(spender, token)` — granted to dApps and contracts. Neither client shows them.

An allowance is a standing permission to move someone's money. A user who
cannot see what they have granted cannot revoke it, and will not remember
granting it.

### What to build

- List active allowances: who, which token, how much, and any expiry.
- Let the user revoke one — read V320 first. There is **no revoke path on the
  deployed contract** and `approve` panics on zero, so until that lands the
  honest UI reduces an allowance rather than claiming to remove it. Do not
  show a control that cannot do what it says.
- Show it where a worried person would look, not buried in a developer screen.

### Acceptance criteria

- [ ] Active allowances are listed with spender, token, amount and expiry
- [ ] Each can be reduced, and revoked outright once V320 makes that possible
- [ ] No control claims to remove an allowance while the contract cannot
- [ ] An expired allowance is shown as expired, not hidden
- [ ] No spender address is shortened in a way that hides which contract it is

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V336 · The contracts have no threat model anyone can read

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:intermediate

### Background

`docs/PRIVACY_THREAT_MODEL.md` exists for the privacy pool. The wallet
contracts — the things that actually hold the money — have no equivalent.

`docs/CONTRACTS_V2.md` is close in places but it is a record of one finding and
its consequences, not a statement of what the wallet assumes and what it does
not defend against.

An external reviewer, or an SCF assessor, has nothing to read.

### What to build

- Who the actors are: the passkey holder, the fee payer, the factory admin, a
  guardian, a dApp holding an allowance, the RPC provider, the indexer.
- For each: what they can do, what they cannot, and what breaks if their key is
  compromised.
- State the known accepted risks plainly, including that deployed contracts
  cannot be upgraded.

### Acceptance criteria

- [ ] Every privileged actor is listed with its real capabilities
- [ ] Each entry says what a compromise of that role costs
- [ ] Accepted risks are stated, not omitted
- [ ] Claims match the code — no capability is described that does not exist
- [ ] It links to the tests that enforce each boundary

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---
