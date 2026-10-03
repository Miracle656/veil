# spp-native — the SPP native boundary, exposed to JS

The native half of the SPP integration. Veil does not own an SPP circuit,
trusted setup, proving key, or verifier. The Rust crate is pinned to
Nethermind/SDF's `stellar-private-payments` SDK and must use its canonical
`TransactParams` and published circuit artifacts.

**Status: the bridge ships, proving does not.** `syncTo` and the note/record
types are live. `prove` and `verify` return a `prover` error instead of a
proof, on purpose — see [What is blocking proving](#what-is-blocking-proving).
No screen gets a proof from this module: the only caller of `prove` is the
benchmark at `/privacy/benchmark`, which shows the refusal, and
`lib/privacy.ts` still surfaces `ENGINE_PENDING_MESSAGE` for
shield/send/unshield. This is the same posture the app already takes about
the privacy engine; it is not a working prover that occasionally fails.

## Layout

```
modules/spp-native/
├── expo-module.config.json      # Expo autolinking manifest (android only)
├── index.js / src/              # JS surface; lib/sppProver.ts is the public API
├── android/
│   ├── build.gradle             # cargo-ndk build + uniffi codegen, wired to preBuild
│   └── .../SppNativeModule.kt   # Expo module wrapping the generated bindings
├── scripts/
│   └── install-rust-toolchain.sh # EAS/GHA provisioning, run by the app's postinstall
└── rust/
    └── spp-prover/              # note format + the SDK boundary (uniffi for Kotlin)
```

## How a build picks it up

`expo-modules-autolinking` scans `modules/`, reads `expo-module.config.json`,
and adds the Android project with the standard `expo-module-gradle-plugin`.
The module's Gradle file hooks `preBuild` (and each `compile*Kotlin` task
directly, so codegen is a hard ordering edge):

1. `buildRust<abi>` compiles `rust/` per ABI with `cargo-ndk` into
   `build/jniLibs/<abi>/libspp_prover.so`.
2. `generateUniffiBindings` runs the in-tree `uniffi-bindgen` binary against
   the host build and emits Kotlin into `build/generated/uniffi` — generated
   code is kept out of the handwritten sources in `src/main/java`. That folder
   is registered as an extra Java source root *and* pushed onto each
   `compile*Kotlin` task via `task.source(...)`, because the
   expo-module-gradle-plugin + AGP wiring does not reliably feed a custom
   source-set root into the Kotlin compile on its own. A `doLast` check fails
   the build if codegen did not produce `uniffi/spp_native/`.

Toolchain provisioning is a build-file concern, so it is wired into the app's
`postinstall` (`sh ./modules/spp-native/scripts/install-rust-toolchain.sh`):
EAS Android images ship the NDK but not Rust, and the hook installs a
stable toolchain plus the android targets and `cargo-ndk`, linking the
binaries where the Gradle daemon's PATH finds them. GitHub Actions gets the
host toolchain from `dtolnay/rust-toolchain` and lets the same hook add the
targets and cargo-ndk. No manual steps, no `eas.json` hooks.

If `cargo` is still missing (a bare `gradle` run on a machine without the
toolchain) the Rust tasks log a warning and skip — the app builds without
the `.so`, the JS layer detects the missing module, and everything falls
back, exactly like a binary built before this module existed.

## Fallback contract

`lib/sppProver.ts` loads the module with `requireOptionalNativeModule` and
returns typed `E_UNAVAILABLE` errors instead of crashing when it is absent.
Old dev clients, Expo Go, and iOS (until the iOS target ships) all behave
like a build with the module reporting "unavailable" — the app launches.
That is the same pattern `lib/backgroundActivity.ts` uses for the
background-task modules.

## What is blocking proving

`prove` and `verify` fail closed with code `prover`. Two things must land
first, and neither is a stub to fill in:

1. **The witness.** The SDK proves from its own `TransactParams` — the pool's
   parameters plus the note preimages in the order the canonical circuit takes
   them. The JS → Kotlin → Rust path here still carries Veil's own
   `ProveRequest` (built for the local circuit that this branch deleted), and
   guessing a mapping onto `TransactParams` is exactly how a wallet ends up
   with proofs nobody verifies. The callers have to be retargeted to produce
   SPP's witness.
2. **The artifacts.** The SDK's `CircuitStore` opens a directory of circuit
   artifact files on the device filesystem — it embeds nothing, and this APK
   carries none. So the open question is delivery, not code: bundle the
   artifacts into the build, or fetch them on first use, and verify either way
   against `stellar_private_payments::CIRCUITS_JSON`, the circuit lockfile
   compiled into the pinned SDK.

Veil must never generate a setup or a proving key. The verifier SPP deploys
accepts only proofs made with SPP's published artifacts, so a locally
generated key is not a fallback — it is a different, unusable circuit. That is
why there is no `generate-key.sh` and no checked-in key here; an earlier
revision of this branch carried a placeholder, and it has been deleted.

**Not the blocker:** the pinned SDK compiles. `cargo check -p spp-prover`
passes on the host (`x86_64-pc-windows-gnu`) at the pinned commit
`a407160de6636e58537402c483bcfd98d8c2ad7d`. The Android cross-build and uniffi
codegen are exercised by CI — the module's Gradle codegen step is Unix-host
only, so no local build here proves the `.so` links.

**Acceptance for this module:** a proof that the canonical testnet pool's
deployed verifier accepts, with the transaction hash recorded in the PR. The
pool's contract addresses live in `lib/privacy/config.ts` (#780), which
`.github/workflows/spp-drift.yml` watches; this crate's git pin is a second,
independent pin, and the two have to be kept in step.

## Benchmark screen

`/privacy/benchmark` calls the real module and times the result, so today it
displays the `prover` refusal. It is deliberately separate from the #720 spike
in `lib/prover/`, which models expected native timings; a benchmark that fakes
a duration cannot answer the question it exists to ask.
