# WASM size optimization

Soroban charges for contract upload and instantiation by bytecode size, so
smaller `.wasm` artifacts mean lower fees for every deployment of a Veil wallet.
The workspace `[profile.release]` in [`contracts/Cargo.toml`](../contracts/Cargo.toml)
is tuned for size, combining link-time optimization, a single codegen unit, the
smallest optimization tier, panic-abort, and symbol stripping.

## The profile

```toml
[profile.release]
opt-level = "z"          # optimize for size (smallest tier) over speed
overflow-checks = true   # keep arithmetic overflow trapping on-chain
debug = 0                # no debug info
strip = "symbols"        # strip symbols AND debuginfo
debug-assertions = false # no debug_assert! in release
panic = "abort"          # no unwinding tables; required for Soroban contracts
codegen-units = 1        # whole-crate codegen for better size optimization
lto = true               # link-time optimization: cross-crate dead-code elimination
```

A few notes:

- **`strip = "symbols"` vs `"debuginfo"`.** `"symbols"` removes the symbol table
  *and* debug info — a strict superset of `"debuginfo"` — so it produces the
  smaller artifact while still leaving valid, runnable WASM.
- **`overflow-checks = true` is deliberately kept on.** On-chain arithmetic
  should trap rather than wrap; the handful of bytes this costs is a worthwhile
  trade for a wallet contract.
- **Workspace-root only.** Cargo applies `[profile.*]` from the workspace root
  and ignores it in member crates, so the profile lives in
  `contracts/Cargo.toml`, not in each contract's `Cargo.toml`.

## Benchmark

Reproduce the numbers with:

```bash
scripts/bench-wasm-size.sh -p invisible-wallet   # one contract
scripts/bench-wasm-size.sh                        # every workspace contract
```

The script builds each contract twice for `wasm32-unknown-unknown` — once with
the profile above, once with a naive release baseline (`opt-level = 3`,
`lto = false`, `codegen-units = 16`, `strip = "none"`) applied via
`cargo --config` overrides — and reports the delta. It mutates nothing on disk.

### Results

`invisible_wallet`, `wasm32-unknown-unknown`, toolchain 1.85.0:

| Build                   | Size (bytes) |
| ----------------------- | -----------: |
| Naive release baseline  |      626,198 |
| Optimized `release`     |       30,319 |
| **Saved**               | **595,879 (95.2%)** |

The dominant contributors are LTO (cross-crate dead-code elimination), symbol
stripping (removing the WASM name section), and the `"z"` size tier; together
they shrink the artifact far past the ~30% target.

> Absolute sizes vary with toolchain and `soroban-sdk` version; the script
> recomputes both sides so the *relative* saving stays meaningful over time.
