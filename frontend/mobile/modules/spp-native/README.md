# spp-native — the Rust SPP prover, exposed to JS

The native half of the V141 prover path. The Rust crate proves SPP
transactions with arkworks (Groth16 over BLS12-381) — the same proof system
the web build compiles to WASM, but parallel on-device instead of
single-threaded in a WebView.

## Layout

```
modules/spp-native/
├── expo-module.config.json      # Expo autolinking manifest (android only)
├── index.js / src/              # JS surface; lib/sppProver.ts is the public API
├── android/
│   ├── build.gradle.kts         # cargo-ndk build + uniffi codegen, wired to preBuild
│   └── .../SppNativeModule.kt   # Expo module wrapping the generated bindings
├── parameters/
│   └── proving-key.bin          # V142 circuit parameters, embedded at build time
└── rust/
    └── spp-prover/              # the proving crate (uniffi for Kotlin)
```

## How a build picks it up

`expo-modules-autolinking` scans `modules/`, reads `expo-module.config.json`,
and adds the Android project. The module's Gradle file hooks `preBuild`:

1. `buildRust<abi>` compiles `rust/` per ABI with `cargo-ndk` into
   `build/jniLibs/<abi>/libspp_prover.so`.
2. `generateUniffiBindings` runs the in-tree `uniffi-bindgen` binary against
   the host build and emits Kotlin into `build/generated/uniffi`.

No manual steps: an EAS build runs the same Gradle graph, and the EAS image
ships Rust and the NDK. If `cargo` is missing (a bare `gradle` run on a
machine without the toolchain) the Rust tasks log a warning and skip — the
app builds without the `.so`, the JS layer detects the missing module, and
everything falls back, exactly like a binary built before this module
existed.

## Fallback contract

`lib/sppProver.ts` loads the module with `requireOptionalNativeModule` and
returns typed `E_UNAVAILABLE` errors instead of crashing when it is absent.
Old dev clients, Expo Go, and iOS (until the iOS target ships) all behave
like a build with the module reporting "unavailable" — the app launches.
That is the same pattern `lib/backgroundActivity.ts` uses for the
background-task modules.

## Regenerating the proving key

After a circuit change:

```bash
sh parameters/generate-key.sh
```

The key is a deterministic function of the constraint system (fixed RNG
seed — no ceremony), so this produces identical bytes on every machine.
Commit the result; the APK carries it inside the `.so`, so proving needs no
network at runtime.

## Testing the V141 benchmark

The fixture transaction lives in two places on purpose, checked against
each other by the test suites: `rust/spp-prover/src/tests.rs` and
`lib/sppBenchmark.ts`. The on-device comparison screen is at
`/privacy/benchmark`.
