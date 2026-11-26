# Live-proof SDK and deployment pin

Issue #1203 needs a browser-compatible SDK and contracts from the same protocol
generation. These fixtures are test-only; production wallet dependencies and
contract addresses are unchanged by this pin.

## Pin

- Upstream repository: https://github.com/NethermindEth/stellar-private-payments
- Source commit: `0ac6da3e171308533b1873155f167a01b69b3aaf`.
- Successful main-branch build: https://github.com/NethermindEth/stellar-private-payments/actions/runs/45198620611
- Artifact ID: `14831881878`.
- Artifact name: `sqlite3mc-web-sdk-0ac6da3e171308533b1873155f167a01b69b3aaf`.
- ZIP SHA-256: `4055905225a56d2b7522a1e3054241e0f3ecec6d523b2730025f58ce2389c298`.
- Package tarball SHA-256: `16216bf58241d128997b482a2753b4904fe62d0d68f91902288dca4c27bf565b`.
- `sdk-files.json`: SHA-256 for all 83 extracted package files, including the
  browser WASM and worker modules. Unexpected files are rejected too.
- `deployments.json`: upstream `deployments/testnet/deployments.json`, copied
  whole at the source commit above.
- `circuits.json`: upstream `deployments/testnet/circuits.json`, copied whole at
  that commit and checked against the package's circuit lock.

The upstream workflow builds the encrypted SDK, tests Chromium storage, and
packages without rerunning lifecycle scripts after qualification. Its artifact
was downloaded into an isolated directory and both archive digests verified.
No downloaded build script was executed to obtain the browser package.

## Why not npm 0.4.0?

The published release at `cebb972b5872cba3a1cc40bcdfab297168ccc1d7` predates the
November 20 deployment at `2dfc76a6afb11e772f1f214bc2fb9ffbfe79929a`.
Its registry uses 32-byte encryption public keys; the newer deployment uses
1,216-byte X-Wing keys. Matching circuit lock metadata does not establish
registry or key-derivation compatibility. Both packages identify themselves as
`0.4.0`, so checking a version string is insufficient.

A real Chromium probe could open encrypted storage with the published SDK, but
its original deployment needed event history outside public RPC retention.
The hosted bootnode refused that old contract set with `unsupported filters`.
Using current contract addresses with the old SDK would not repair this.

The pinned main build successfully initialized encrypted OPFS and synced the
current deployment in Chromium. Sync alone is not payment evidence. The
separate live run must still complete shield, send and unshield and independently
confirm full transaction hashes.

## Boundaries

This is an explicit pin for an opt-in test fixture, not an implicit upgrade of
Veil's production key derivation or storage scheme. A production upgrade needs
recoverable wrapping for its random database key, account lifecycle handling,
and real signer/adapter tests; an in-memory test key cannot replace that design.

GitHub artifacts expire. The source commit, workflow, archive digests and file
manifest document exactly what was exercised. If the artifact is unavailable,
rebuild the pinned source using its documented toolchain and review any byte
mismatch rather than accepting an arbitrary build or disabling verification.
Future SDK/deployment/circuit updates must be separate explained commits.
