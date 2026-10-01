# Reproducible contract builds

Veil's Soroban contracts are built deterministically so that **anyone can verify
a deployed contract hash was produced from this public source** — no trust in
the maintainers' build machine required.

## How it works

The build is pinned along every axis that can affect the output bytes:

- **Toolchain** — `contracts/rust-toolchain.toml` pins Rust to `1.85.0`.
- **Dependencies** — `contracts/Cargo.lock` is built with `--locked`.
- **Environment & paths** — the build runs inside the
  `rust:1.85.0-bookworm@sha256:0ff31c9ffa641a62e48d543fb00b4960955ea375f40776f40f585b89e654cc5e`
  Docker image (pinned by immutable digest) with the repository mounted at a fixed
  path (`/work`) and a fixed `CARGO_HOME`, so the absolute paths `rustc` embeds
  are identical on every machine, including CI.

Because all of these are fixed, the release `.wasm` artifacts — and therefore
their SHA-256 hashes — are byte-identical across machines. The expected hashes
are committed in [`contracts/expected-hashes.json`](../contracts/expected-hashes.json).

## Verify it yourself

You need Docker installed. From the repository root:

```bash
scripts/reproducible-build.sh
```

This builds the contracts in the pinned image, hashes the resulting `.wasm`
artifacts, and compares them against `contracts/expected-hashes.json`. It exits
non-zero if any hash drifts.

To build against the host toolchain instead of Docker (must match
`rust-toolchain.toml`):

```bash
scripts/reproducible-build.sh --no-docker
```

## Updating the expected hashes

When a contract change intentionally alters the WASM, regenerate the committed
hashes and commit the result:

```bash
scripts/reproducible-build.sh --update
git add contracts/expected-hashes.json
```

## CI

The [`reproducible-build`](../.github/workflows/reproducible-build.yml) workflow
runs on every push and pull request to `main`. It:

1. Builds and verifies the WASM hashes against the committed values in a container
   pinned by digest — failing the job on any drift.
2. Performs an independent second build starting from a clean checkout with an
   empty `target/` directory and asserts both runs produce identical hashes.
3. Records the resulting WASM hashes in the GitHub Actions job summary for
   reviewer inspection.
