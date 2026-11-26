# Browser-driven private payment evidence

Issue: [#1203](https://github.com/Miracle656/veil/issues/1203)

On **2026-11-23**, a deliberate Chromium run completed real **shield → private
send → unshield** on Stellar testnet. All five transactions (two registrations
and three payment operations) independently returned `SUCCESS` from the public
RPC. No RPC, Horizon, Friendbot, registry, storage, or prover response was mocked.

## What this proves — and what it does not

The browser loaded the actual Stellar Private Payments WASM, opened encrypted
OPFS storage in two isolated browser contexts, derived and registered privacy
keys, generated proofs in workers, and executed the three operations on the
pinned pool. Playwright clicked the test driver's controls; the SDK and proofs
ran in Chromium, not Node. Node supplied signatures from two newly generated
Friendbot-funded accounts and independently checked the chain results.

This is a **browser SDK integration proof**, not a test of Veil's Next.js privacy
screens, the existing `lib/privacy/client.ts` production adapter, passkey
onboarding, or PRF recovery. Those paths are not upgraded or validated by this
change. In particular, do not interpret these hashes as evidence that Veil's
older production SDK/configuration is compatible with the latest deployment.

The local test driver explicitly labels these limitations. The database key and
signer secrets were memory-only; no recovery or persistence guarantee is claimed.
The disposable accounts contain only testnet assets. Their private note balances
are intentionally published here for verification of this test, not as a
privacy-preserving way to operate a real wallet.

## Exact deployment and identities

- Network: `Test SDF Network ; September 2015`.
- RPC: `https://soroban-testnet.stellar.org/`.
- Pool: `CBKLEZ3T7EFGQS3OFB4KGAAKEZ3KF2YJTWBOXWKUIKTIFWJ56UF6SNKI`.
- Native-token contract: `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`.
- Registry: `CC6KIK4Q2IHBQ5QN6NFU4CE5E4HZ567ITV6BWRF3FHBAEOT3HWHRYFVC`.
- Sender: `GD2UDLEXIGUESBGTF2PBWPY3RM74JSBZZSLE66XD75UO667YFI3G6HVB`.
- Recipient: `GASFWVTYUWHTE5IZP4UKZAMKCILVVPU4KDVTPYOVBR4RKVGT2LRWNOCZ`.
- Upstream source: `0ac6da3e171308533b1873155f167a01b69b3aaf`.
- Chromium: `156.0.8078.4`; Node: `v22.16.0`.
- Run: `2026-11-23T20:38:36.379Z`–`2026-11-23T20:43:00.431Z`.

The full deployment, trusted circuit lock, build provenance, and all 83 SDK file
hashes are pinned in
[`frontend/wallet/e2e-live/privacy/`](../frontend/wallet/e2e-live/privacy/SDK_PIN.md).
The compatibility pin is a separate commit from the harness and evidence.
It uses a hash-verified upstream main-branch CI artifact, **not npm `0.4.0`**,
which predates the X-Wing registry redeployment despite sharing a version string.
Production package dependencies remain unchanged.

## Full transaction hashes

| Operation | Ledger | Transaction hash |
| --- | --- | --- |
| Sender registration | 5888558 | [`ff7159b90d7dc936ead1e723bdd3ebedde8d38a62704e8b59f90bcb8342a88f9`](https://stellar.expert/explorer/testnet/tx/ff7159b90d7dc936ead1e723bdd3ebedde8d38a62704e8b59f90bcb8342a88f9) |
| Recipient registration | 5888561 | [`48b41ee1c472e3983568886d00ff4e88af63f7e92f61f01afb1cc9d01bf84bbb`](https://stellar.expert/explorer/testnet/tx/48b41ee1c472e3983568886d00ff4e88af63f7e92f61f01afb1cc9d01bf84bbb) |
| Shield 5 XLM | 5888568 | [`c6cc681762db0b3ea5a718c72c8e8baefac2470ca523877f56f9864d62afaa2e`](https://stellar.expert/explorer/testnet/tx/c6cc681762db0b3ea5a718c72c8e8baefac2470ca523877f56f9864d62afaa2e) |
| Send 2 XLM privately | 5888577 | [`7012b2f06d5c468e76b20a4aea78f52b4b1c9daab78b884ed33c55844b247f03`](https://stellar.expert/explorer/testnet/tx/7012b2f06d5c468e76b20a4aea78f52b4b1c9daab78b884ed33c55844b247f03) |
| Unshield 1 XLM | 5888587 | [`501c745abdc814a95efa84eee72e1913ad6fb7babb5875e641e4ef751c238559`](https://stellar.expert/explorer/testnet/tx/501c745abdc814a95efa84eee72e1913ad6fb7babb5875e641e4ef751c238559) |

All five independently confirmed as `SUCCESS`. The verifier also decoded each
payment's signed envelope and checked that its expected sender invoked
`transact` on the pinned pool, rather than accepting an arbitrary successful
transaction hash. It checks the effective operation source as well as the
envelope source, rejects hashes reused across payment actions, and requires
shield/unshield transfer events on the qualifying pool transaction itself rather
than accepting an unrelated public transfer.

### Value movement

Amounts below are integer stroops (10,000,000 stroops = 1 XLM).

- Shield produced a private sender balance of `50000000`. The native token's
  confirmed transfer event moved `51000000` from sender to pool: 5 XLM in notes
  plus the 0.1 XLM pool fee. Network fees are additional.
- Private send left sender with `29000000` and recipient with `20000000` in
  private notes. The confirmed transaction had **no public native-token transfer
  event**; the recipient's browser synced and observed the private output.
- Unshield reduced recipient notes from `20000000` to `9000000`. The native
  token's confirmed event transferred exactly `10000000` from pool to recipient.
- Recipient public XLM increased from `9999.8599611` to `10000.0746364` around
  withdrawal. This net account delta includes Soroban fees/refunds and must not
  be substituted for the authoritative 1 XLM token-transfer event.

A chain observer cannot independently decrypt the private-send amount from its
hash alone. The evidence combines the successful pool call, recipient-side
synced balance, and recipient's subsequent spend/unshield. It does not claim
that private amounts become publicly verifiable.

## Durable artifacts

- [Unmodified completed run JSON](privacy-evidence/2026-11-23/evidence.json):
  full hashes, identities, action results, balances, runtime versions, and RPC
  confirmations recorded during the browser run.
- [Separate read-only chain verification](privacy-evidence/2026-11-23/chain-verification.json):
  independently re-fetched confirmations and decoded native-token transfer events.
- [Inspected recipient unshield screenshot](privacy-evidence/2026-11-23/unshield.png).

No signer secrets, signed authorization entries, encrypted database contents,
or database keys are committed. Testnet resets and RPC retention can eventually
remove externally queryable history; these records preserve what was observed,
not a promise that a public endpoint will retain it indefinitely.

## Reproduce deliberately

Follow the [live harness instructions](../frontend/wallet/e2e-live/privacy/README.md)
to obtain and verify the pinned SDK, then run from `frontend/wallet`:

```bash
SPP_LIVE_TESTNET=1 SPP_SDK_ROOT="/absolute/path/to/verified/package" \
  node e2e-live/privacy/run.mjs
```

This creates new disposable identities and submits **new testnet transactions**.
It is excluded from the ordinary Playwright test directory, requires explicit
opt-in, uses one action at a time, and has no money-moving retries. Never repeat
a timed-out operation before checking every signed/returned hash. A later sync
failure does not prove a previous submission failed.

To re-check this run without signing or submitting anything:

```bash
node e2e-live/privacy/verify-chain.mjs ../../docs/privacy-evidence/2026-11-23/evidence.json
```

Public RPC transaction retention limits apply to this read-only command.

## Failures that informed the final harness

1. Published npm `0.4.0` could not sync its original deployment because the
   archive rejected that older contract set; it is also incompatible with the
   new registry's encryption-key format.
2. An initial registration attempt hit a network fetch failure after the sender
   registration confirmed. The runner stopped; it did not resubmit automatically.
3. A later shield attempt returned no hashes and a 30-second SDK timeout. The
   sender's chain history was checked before continuing; it contained only
   funding and registration. The timeout string alone was not treated as proof
   of a prover-specific problem because storage uses the same wording.
4. Preparing every enabled pool's circuits failed on the unused view-only GVK
   circuit's 60-second preparation deadline, before any funding in that run.
   The final driver prepares only the standard blocklist transaction circuit
   and key-ownership circuit via the public API, keeping the full pinned
   deployment intact. That final run completed all three payment operations.
