# Deliberate browser privacy proof (testnet only)

This is **not** part of `playwright test` or the wallet E2E workflow. It is a
standalone, explicitly gated Chromium driver. There are no automatic retries of
registration or payment actions. It uses the real SDK, WASM, encrypted OPFS,
prover workers, circuit files, public registry and pool. No chain responses are
mocked.

Scope: disposable Ed25519 testnet accounts supplied through the SDK's signer
interface, **not Veil passkey onboarding, PRF recovery, the Next.js privacy UI,
or the production `lib/privacy/client.ts` adapter**. A successful run must not
be presented as proof of those paths. The local HTML is a test driver rather
than an alternative wallet. Never use an existing wallet or mainnet secrets.

## Why this SDK pin is separate from the production dependency

The npm release `stellar-private-payments@0.4.0` was built at
`cebb972b5872cba3a1cc40bcdfab297168ccc1d7`, before the November 20 testnet
redeployment. It supplies 32-byte encryption keys, whereas the current registry
requires 1,216-byte X-Wing keys. Its original deployment also starts before the
public RPC retention window; the hosted archive rejected that older contract
set with `unsupported filters` during a real Chromium sync probe.

This fixture instead pins the encrypted SDK produced by upstream's successful
main-branch **SQLite3MC qualification** workflow, at
`0ac6da3e171308533b1873155f167a01b69b3aaf`:

- Source/workflow: https://github.com/NethermindEth/stellar-private-payments/actions/runs/45198620611
- Artifact: `sqlite3mc-web-sdk-0ac6da3e171308533b1873155f167a01b69b3aaf`, ID `14831881878`.
- ZIP SHA-256: `4055905225a56d2b7522a1e3054241e0f3ecec6d523b2730025f58ce2389c298`.
- Contained `stellar-private-payments-0.4.0.tgz` SHA-256: `16216bf58241d128997b482a2753b4904fe62d0d68f91902288dca4c27bf565b`.

The artifact still identifies itself as `0.4.0`; **it is not the npm release**.
`sdk-files.json` pins the content of all 83 extracted package files. The runner
verifies every file before starting Chromium or funding accounts. The separate
`circuits.json` is copied from the pinned source commit, not trusted from a
mutable server. `deployments.json` is also copied in full from that commit,
including all four pools and the GVK metadata. The test selects only the
standard native XLM pool.

The production npm dependency remains unchanged. Do not install this unpublished
CI artifact into the production wallet merely to make this diagnostic pass.
A production upgrade also needs encrypted-storage key wrapping/recovery and
signer/integration tests; this fixture's memory-only database key is deliberately
not a production persistence design.

## Install and obtain the pinned build

Use Node 20+ and run plain npm commands in `frontend/wallet`:

```bash
npm ci
npx playwright install chromium
node --test e2e-live/privacy/safety.test.mjs e2e-live/privacy/verify-chain.test.mjs
```

Download into a new empty directory, inspect the archive, verify its digest,
and extract there. Keep working in the repository, not the downloaded directory.
GitHub Actions artifact download requires an authenticated `gh` account:

```bash
artifact_dir=$(mktemp -d)
gh api repos/NethermindEth/stellar-private-payments/actions/artifacts/14831881878/zip > "$artifact_dir/sdk.zip"
printf '%s  %s\n' 4055905225a56d2b7522a1e3054241e0f3ecec6d523b2730025f58ce2389c298 "$artifact_dir/sdk.zip" | sha256sum -c -
unzip -l "$artifact_dir/sdk.zip"
unzip "$artifact_dir/sdk.zip" -d "$artifact_dir"
printf '%s  %s\n' 16216bf58241d128997b482a2753b4904fe62d0d68f91902288dca4c27bf565b "$artifact_dir/stellar-private-payments-0.4.0.tgz" | sha256sum -c -
tar -tzf "$artifact_dir/stellar-private-payments-0.4.0.tgz"
tar -xzf "$artifact_dir/stellar-private-payments-0.4.0.tgz" -C "$artifact_dir"
```

Artifacts expire. If this artifact is unavailable, do not substitute a newer
build or npm `0.4.0`. Rebuilding this commit requires the toolchain and steps in
its `.github/workflows/sqlite3mc.yml`; build reproducibility must be checked
against `sdk-files.json` before this runner will accept it. If the hashes differ,
review and explicitly re-pin the SDK/deployment/circuits together in a separate
commit; do not disable integrity checking.

## Run once deliberately

```bash
SPP_LIVE_TESTNET=1 \
SPP_SDK_ROOT="$artifact_dir/package" \
SPP_EVIDENCE_DIR="$(pwd)/e2e-live/privacy/results/$(date -u +%Y%m%dT%H%M%SZ)" \
node e2e-live/privacy/run.mjs
```

On Windows Git Bash, use an absolute Windows-style path for `SPP_SDK_ROOT`, for
example the full path printed by `cygpath -w "$artifact_dir/package"`. Set
`SPP_HEADED=1` to watch Chromium.

The driver checks the testnet passphrase and SDK/circuit integrity, initializes
two isolated browser storage partitions, prepares only `policy_tx_2_2_B` and
`keyOwnership` through the public `ProverBridge.prepareCircuits()` API, syncs
both, then funds two new G accounts with Friendbot. It clicks controls to register
both accounts, shield 5 XLM, send 2 XLM privately, and unshield 1 XLM from the recipient back to their
own G account. Amounts are bigint base units. Pool and network fees apply.

The browser's encrypted database key and signer secrets live only in memory.
Closing the driver destroys that test session; it is **not** a backup/recovery
test. A failed run may leave testnet notes in its disposable accounts. Do not
use real assets, reuse an existing account, or blindly rerun a failed payment.

## Evidence and failure handling

`evidence.json` records the full public addresses, every returned transaction
hash (including hashes returned by failed multi-step operations), timestamps,
private balances, public balance checks and independent RPC confirmations.
Screenshots show each clicked action. No traces, signer secrets or database keys
are exported. Generated results are gitignored; only reviewed public evidence
from a completed run should be copied into `docs/`.

If an action fails, inspect `evidence.json` and look up every recorded hash first.
A timeout or failed fetch is not proof that a transaction was never submitted.
The driver stops instead of automatically repeating money-moving operations.
A run is successful only when its status is `completed`, all three payment
actions returned successful results, all recorded hashes independently confirm,
and the recipient's public XLM balance increases after unshielding. The read-only
verifier also checks signed `transact` calls against the expected pool and
signers, real shield/unshield native-token transfer events, and the absence of
a public token transfer during private send.

To re-check a completed evidence file without funding or signing:

```bash
node e2e-live/privacy/verify-chain.mjs /absolute/path/to/evidence.json
```

RPC transaction retention limits apply. The checked-in completed run and its
full hashes are in [`docs/PRIVACY_E2E.md`](../../../../docs/PRIVACY_E2E.md).

A source build, a successful sync, a registration transaction, a screenshot, or
a green mocked unit test alone is **not** shield/send/unshield evidence.
