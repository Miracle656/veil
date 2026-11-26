# Wave batch — every alarm is already ringing (V307–V316)

Drafted 2026-10-20 by reading `Miracle656/veil` at `main` and the last six runs
of every scheduled workflow. Checked against the open veil issues first;
nothing here duplicates one.

The theme: **six scheduled workflows have failed their last six runs.**

```
release.yml               failure,failure,failure,failure,failure,failure
wallet-e2e.yml            failure,failure,failure,failure,failure,failure
testnet-smoke.yml         failure,failure,failure,failure,failure,failure
memory-leak-nightly.yml   failure,failure,failure,failure,failure,failure
mutation.yml              failure,failure,failure,failure,failure,failure
asset-registry-verify.yml failure every day since at least 2026-10-15
```

The asset-registry one already has an issue — #978 — so it is not repeated
here. The rest are below, one per workflow.

Not one of these is a flake. Each has been red long enough that a red result
carries no information: nobody can tell the morning the smoke test fails
because mainnet is actually broken from the morning it fails because it has
failed every morning for a fortnight. An alarm that always rings is not an
alarm, and `asset-registry-verify.yml` opens a GitHub issue on every failure,
so the noise has started filing paperwork about itself.

These issues are deliberately one workflow each. Fixing a red job is not
glamorous and it is some of the most valuable work available here, because
every other check in the repo is worth more once these are quiet.

## Shared with every issue

**Repo:** `Miracle656/veil`. Mobile is `frontend/mobile` (Expo / React Native),
the web wallet is `frontend/wallet` (Next.js), contracts are `contracts/`
(Rust / Soroban). The backend is the sibling repo `Miracle656/wraith`.

**Run the tests:** `npm test` in `frontend/mobile` (jest via jest-expo) or
`frontend/wallet`. **Install with plain `npm install` in `frontend/mobile`** —
never `--legacy-peer-deps`, which corrupts that lockfile.

**Read the workflow before you change it.** Most of these fail for a reason
that is recorded in the job log; `gh run list --workflow <file>` and
`gh run view <id> --log-failed` will tell you more in a minute than guessing
will in an hour.

**Fixing the check is the job. Deleting the check is not.** If a job tests
something that no longer exists, say so in the PR and remove it deliberately,
with the reasoning written down — that is a legitimate outcome. Making it pass
by weakening what it asserts is not, and will be sent back.

**Do not disable a job to make it green.** A skipped job and a passing job look
identical on a dashboard, which is how this situation started.

**This wallet holds real money on mainnet.** Several of these checks exist
because a specific thing went wrong once. Before you change what one asserts,
find out what it was protecting.

**Never elide an address, a contract id or a key** in code, comments or test
fixtures. A previous batch shortened a contract id in an issue and five
contributors invented their own to fill the gap.

---

### V307 · The public docs describe two contract upgrade paths. Neither exists.

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:intermediate

### Background

`frontend/docs/pages/contract-upgrades.mdx:44` tells the public:

> Veil has two contracts that can be upgraded independently:
>
> | Contract | Upgrade Mechanism | Affects |
> |---|---|---|
> | **Factory** | `set_wasm_hash` | Only **new** wallet deployments |
> | **Invisible Wallet** (per-wallet) | `update_current_contract_wasm` | Each **existing** wallet individually |

Both rows are false, and this page is published.

The factory exposes exactly three entrypoints:

```rust
// contracts/factory/src/lib.rs
pub fn __constructor(env: Env, admin: Address)
pub fn init(env: Env, wasm_hash: BytesN<32>) -> Result<(), FactoryError>
pub fn deploy(env: Env, public_key: BytesN<65>, rp_id: Bytes, origin: Bytes) -> Result<Address, FactoryError>
```

`set_wasm_hash` is an internal storage helper in
`contracts/factory/src/storage.rs`, not a contract function — there is no way
to call it after deployment.

`update_current_contract_wasm` appears nowhere in `contracts/` at all. Grep the
whole directory for it and for `fn upgrade`: both return nothing. The wallet
contract's public surface is `init`, `add_signer`, `remove_signer`,
`rotate_signer`, `__check_auth`, `get_nonce`, `has_signer`, `get_signers`,
`execute`, `approve`, `get_allowance`, `set_guardian`, `initiate_recovery`,
`complete_recovery`. No upgrade.

**The mainnet factory and every wallet deployed from it are permanent.** That
is a defensible design — immutability is a real security property and some
people will prefer it — but it is the opposite of what the documentation
promises, and somebody deciding whether to trust this wallet with money is
reading the promise.

### What to build

- Correct `contract-upgrades.mdx` to describe what the contracts actually do.
- State plainly that deployed contracts cannot be upgraded, and what that means
  in practice: a fix ships as a new factory at a new address, and existing
  wallets keep running the code they were deployed with.
- Check `architecture.mdx` and `security.mdx`, which also discuss upgrades, for
  the same claim.
- `docs/CONTRACTS_V2.md` already records the true position — reconcile the
  public page with it rather than inventing a third account.

### Acceptance criteria

- [ ] No page claims a deployed contract can be upgraded
- [ ] The factory's real entrypoints are described accurately
- [ ] The consequence for an existing wallet holder is stated in plain language
- [ ] `architecture.mdx` and `security.mdx` agree with the corrected page
- [ ] Nothing asserts an upgrade mechanism that does not appear in `contracts/`

> **Drips Wave** · Complexity: **Intermediate** · **200 points**

---

### V309 · `Release` has failed its last six runs

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate

### Background

`.github/workflows/release.yml` fails on every run — six for six. The failing
step is `Version or publish`.

The SDK is published: `invisible-wallet-sdk@0.2.0` is on npm. So releases are
reaching the registry somehow, and the automated path is not the one doing it.
That is the worst arrangement available — a manual process nobody has written
down, plus a red job that makes the dashboard useless.

Relevant: the npm Trusted Publisher configuration for this package was never
completed, which is a plausible cause of a publish step failing after a
successful build.

### What to build

- Read the failing run (`gh run view <id> --log-failed`) and find the real
  cause rather than guessing from this description.
- Fix it so a release either completes or fails for a reason that is specific
  and actionable.
- If the job needs repository configuration that only a maintainer can supply
  (a token, a Trusted Publisher entry), say so explicitly in the PR — that is a
  valid finding and the issue still counts.
- Document what the release path actually is, in the PR or in `sdk/README.md`.

### Acceptance criteria

- [ ] The root cause is identified and stated, not worked around
- [ ] The job either passes or fails with a specific, actionable message
- [ ] Any maintainer-only configuration required is named precisely
- [ ] The release path is written down somewhere a contributor can find it

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V310 · `Wallet E2E Tests` has failed its last six runs

**Labels:** help wanted, Stellar Wave, area:web, difficulty:intermediate

### Background

`.github/workflows/wallet-e2e.yml` is red six for six. It has been red long
enough that contributors are told, in review, that it is "pre-existing red on
`main` and not your PR" — which is true, and is also how a real regression
would now reach `main` unnoticed.

An end-to-end suite is the only check that exercises the wallet the way a
person does. While it is red, nothing does.

### What to build

- Diagnose the actual failure from the job log.
- Fix it, or — if it tests a flow that no longer exists — remove those cases
  deliberately and say why in the PR.
- If it is flaky rather than broken, make it deterministic. A flaky e2e suite
  becomes an ignored e2e suite, which is where this one already is.

### Acceptance criteria

- [ ] The failure is diagnosed and the cause stated in the PR
- [ ] The suite passes on `main`
- [ ] Nothing was made to pass by weakening what it asserts
- [ ] Any removed case is justified in the PR, not silently dropped

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V311 · `Testnet Smoke Test (Nightly)` has failed its last six runs

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate

### Background

`.github/workflows/testnet-smoke.yml` runs nightly against testnet and is red
six for six. It files an issue on each failure, so #1118, #1122, #1129 and
#1146 are all the same failure on four consecutive nights. Closing those is
part of this issue; stopping them being created is the point of it.

This is the check that would notice the wallet stopped working against a live
network — a contract address that moved, an RPC that changed behaviour, a
deployment that never happened. It is the closest thing the repo has to "is the
product actually alive", and it currently answers "no" every night regardless.

### What to build

- Find out why it fails. Distinguish *the smoke test is broken* from *the thing
  it smokes is broken* — they need opposite fixes, and the second one is a far
  more interesting finding.
- Make a failure mean something: the job should say which step against which
  network failed, and with what response.
- If it depends on a deployed backend being awake, handle a cold start
  explicitly rather than failing on it. The backends sleep when idle.

### Acceptance criteria

- [ ] The cause is identified and stated in the PR
- [ ] The nightly run is green, or fails with a specific diagnosis if testnet is genuinely down
- [ ] Failure output names the step, the network and the response
- [ ] A sleeping backend does not read as a broken wallet

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V312 · `Mutation Tests` has failed its last six runs

**Labels:** help wanted, Stellar Wave, area:testing, difficulty:intermediate

### Background

`.github/workflows/mutation.yml` is red six for six.

Mutation testing answers the question ordinary coverage cannot: not "was this
line executed" but "would any test notice if it were wrong". That is worth
having in a wallet. It is worth nothing while the job cannot complete.

### What to build

- Diagnose the failure: a mutation run that errors out is different from one
  that completes and reports surviving mutants.
- If it completes and fails a threshold, that is a real result — report what
  survived rather than lowering the threshold.
- If the runner itself breaks (timeout, memory, config drift), fix that and say
  what it was.

### Acceptance criteria

- [ ] The job completes and produces a report
- [ ] The failure cause is stated in the PR
- [ ] A threshold was not lowered to make it pass
- [ ] Surviving mutants, if any, are listed so they can become follow-up work

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V313 · `Memory Leak Nightly` has failed its last six runs

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background

`.github/workflows/memory-leak-nightly.yml` is red six for six.

A leak check is exactly the kind of job that is only useful as a *change* in
signal — it matters when it goes from green to red. Six consecutive reds mean
it can no longer deliver that signal at all.

### What to build

- Diagnose from the job log.
- Fix the job, or the leak, depending on which is broken — and say which.
- If the job's threshold was never calibrated against real numbers, calibrate
  it and write the chosen number down with the reason.

### Acceptance criteria

- [ ] The job passes on `main`, or reports a real leak with evidence
- [ ] The PR says whether the fix was to the job or to the code
- [ ] Any threshold is justified, not picked to make the run green

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V314 · `SPP Config Drift Check` fails intermittently, and nobody knows which runs matter

**Labels:** help wanted, Stellar Wave, area:privacy, difficulty:intermediate

### Background

`.github/workflows/spp-drift.yml` is the odd one out in this batch: its last
six runs are `success, success, success, failure, success, failure`. It is not
permanently broken — it is **flaky**, which in some ways is worse. A job that
fails a third of the time teaches people to re-run it rather than read it.

It watches for drift between our pinned Stellar Private Payments configuration
and what is actually deployed. We already know the published SPP npm SDK is
well behind the deployed contracts, so drift here is a real risk and this check
is the thing meant to catch it.

### What to build

- Determine whether the failures are genuine drift or an unreliable check
  (network timeouts, an unpinned upstream, a rate limit).
- If it is the check: make it deterministic, and distinguish "could not reach
  upstream" from "upstream disagrees with our pin". Only the second is drift.
- If it is genuine drift: report precisely what moved. #988 is the alert this
  job filed and may already describe the real drift — read it first.

### Acceptance criteria

- [ ] Ten consecutive runs produce the same result on an unchanged `main`
- [ ] An unreachable upstream is reported as unknown, never as drift
- [ ] A real disagreement names the field, the pinned value and the upstream value
- [ ] The PR states which of the two causes was behind the observed flakiness

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V315 · AQUA is filed as an equity. It is a governance token.

**Labels:** help wanted, Stellar Wave, area:web, difficulty:easy

### Background

Both asset registries classify AQUA as an equity:

```ts
// frontend/wallet/lib/assets.ts:71  and  frontend/mobile/lib/assets.ts:90
AQUA: {
  code: 'AQUA',
  issuer: 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
  name: 'Aquarius',
  kind: 'equity',
  ...
}
```

AQUA is Aquarius's governance token. It is not equity in anything — there is no
company, no shareholding, and holding it is not ownership of an entity.

The immediate cause is that the type has nowhere else to put it:

```ts
kind: 'treasury' | 'fund' | 'equity' | 'stablecoin' | 'native'
```

Today this is cosmetic in one place and not in another. `lib/portfolio.ts`
buckets `treasury`, `fund`, `equity` and the default case all into `invest`, so
the totals are unaffected. But the field is a claim about what the user owns,
and describing a governance token as equity is the kind of statement that reads
very differently in a financial product than in a type definition.

An earlier revision of this registry had `kind: 'governance'` with a comment
noting AQUA floats and must never get a hardcoded rate. That reasoning was
right and was lost.

### What to build

- Add `'governance'` to the `kind` union in both clients and classify AQUA as
  that.
- Keep the two registries identical — `registryParity.test.ts` enforces this
  and will fail if they drift.
- Decide deliberately which portfolio bucket `governance` belongs in, and say
  why in a comment. `invest` is probably right; it should not be an accident.
- Restore the note that AQUA floats and is priced from the order book, never
  from a hardcoded rate.

### Acceptance criteria

- [ ] `kind` includes `'governance'` and AQUA uses it, in both clients
- [ ] `registryParity.test.ts` passes
- [ ] `lib/portfolio.ts` handles the new kind explicitly rather than by `default`
- [ ] A comment records why AQUA must never carry a hardcoded price
- [ ] No issuer address anywhere in the diff is shortened or elided

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V316 · Nothing tells a contributor which checks are expected to be red

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy

### Background

Six scheduled workflows are red on `main`. A contributor opening their first PR
cannot tell which failures are theirs, and finds out only when a reviewer tells
them. That is a bad first experience and it wastes a round of review on every
single PR.

It is also how a real regression hides: when "some of these are always red" is
folklore rather than a written list, the one that just turned red looks the
same as the five that always were.

### What to build

- A short section in `CONTRIBUTING.md` listing the currently-failing checks,
  one line each, with a link to the issue tracking the fix (this batch, plus
  #978 for the asset-registry check).
- Say explicitly which checks a contributor **is** responsible for.
- Make it obvious the list is meant to shrink: it is a defect register, not a
  permanent feature.

### Acceptance criteria

- [ ] `CONTRIBUTING.md` lists every currently-red scheduled check
- [ ] Each entry links to the issue for fixing it
- [ ] The checks a PR author is responsible for are stated plainly
- [ ] The section says the list is temporary and should be deleted as it empties

> **Drips Wave** · Complexity: **Easy** · **100 points**

---
