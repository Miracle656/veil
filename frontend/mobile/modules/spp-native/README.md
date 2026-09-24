# spp-native — the SPP native boundary, exposed to JS

The native half of the SPP integration. Veil does not own an SPP circuit,
trusted setup, proving key, or verifier. The Rust crate is pinned to
Nethermind/SDF's `stellar-private-payments` SDK and must use its canonical
`TransactParams` and published circuit artifacts.

## Layout

```
modules/spp-native/
├── expo-module.config.json      # Expo autolinking manifest (android only)
├── index.js / src/              # JS surface; lib/sppProver.ts is the public API
├── android/
│   ├── build.gradle             # cargo-ndk build + uniffi codegen, wired to preBuild
│   └── .../SppNativeModule.kt   # Expo module wrapping the generated bindings
├── parameters/
│   ├── proving-key.bin          # checked-in placeholder until SPP artifacts land
│   └── check-placeholder.sh     # refuses to ship the placeholder
├── scripts/
│   └── install-rust-toolchain.sh # EAS/GHA provisioning, run by the app's postinstall
└── rust/
    └── spp-prover/              # the proving crate (uniffi for Kotlin)
```

## How a build picks it up

`expo-modules-autolinking` scans `modules/`, reads `expo-module.config.json`,
and adds the Android project with the standard `expo-module-gradle-plugin`.
The module's Gradle file hooks `preBuild`:

1. `buildRust<abi>` compiles `rust/` per ABI with `cargo-ndk` into
   `build/jniLibs/<abi>/libspp_prover.so`.
2. `generateUniffiBindings` runs the in-tree `uniffi-bindgen` binary against
   the host build and emits Kotlin into `build/generated/uniffi`.

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

## Proving artifacts

`parameters/generate-key.sh` intentionally exits with an error. Veil must
never generate a setup or proving key: the verifier deployed by SPP only
accepts proofs made with SPP's published artifacts. The artifacts must be
obtained from the pinned SPP release and verified against its circuit lockfile.

```bash
sh parameters/check-placeholder.sh
```

The current legacy Veil request shape is rejected by the native adapter until
the JS/Kotlin callers send SPP's canonical transaction witness. This is
intentional: producing a proof for a locally defined shape would be unsafe.

## Benchmark screen

The existing comparison screen remains available at
`/privacy/benchmark`.
