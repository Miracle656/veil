# ADR 0004 — Mobile Prover: WebView vs Native Module

| Field     | Value                                           |
|-----------|-------------------------------------------------|
| Status    | Proposed                                        |
| Date      | 2026-09-23                                      |
| Deciders  | Veil core team                                  |
| Issue     | [#720](https://github.com/Miracle656/veil/issues/720) |

---

## Context

Stellar Private Payments (SPP) proves transactions with a **Groth16 circuit over BN254**
compiled to WebAssembly.  The browser SDK (`stellar-private-payments` npm package) ships
a WASM binary (~42 MB tarball, 95 MB unpacked) and a ~12 MB circuit file that is
downloaded on first use.

React Native's **Hermes engine has no WebAssembly**.  The browser SDK therefore cannot
run directly inside the `frontend/mobile` Expo app.  Two options exist:

| Option | Description |
|--------|-------------|
| **A — WebView** | Load the browser SDK in a hidden `react-native-webview` (0×0, opacity 0). Post the transaction in via `postMessage`; receive the proof back the same way. The WebView runs Chromium's V8, which has WASM. |
| **B — Native module** | Wrap the Rust SDK (`stellar-private-payments/sdk/native`, arkworks/BN254, Rayon thread pool) in a React Native Nitro Module (JSI). Compile to a `.so` per ABI and link via `CMakeLists.txt`. |

This ADR records the spike measurements, the trade-off analysis, and the team's
decision.

---

## Measurement Methodology

### Device

| Field | Value |
|-------|-------|
| Name  | *(fill in after device run — target: Redmi 9, Helio G80, 3 GB RAM, Android 11, API 30)* |
| Model string | *(expo-device `brand + modelName`)* |
| Android API | *(expo-device `platformApiLevel`)* |
| Total RAM | *(expo-device `totalMemory`)* |
| CPU cores | *(navigator.hardwareConcurrency)* |

Use a sub-$150 Android phone with 3–4 GB RAM as the target — this represents the
low-end of the user base that matters most for SPP latency decisions.

### Reproducing the benchmark

1. Build a dev client with `npm run build:android:dev` from `frontend/mobile`.
2. Install on the target device and open the app.
3. Navigate to **Settings → Developer → Prover Spike** (or `veil://prover-spike`).
4. Tap **"Run WebView prover"** and record the displayed proof time and heap delta.
5. Tap **"Run Native (stub)"** and record the same.
6. Tap **"Export JSON → ADR 0004"** and paste the JSON output into the table below.
7. Repeat on at least two devices.

> **Note on the native stub:** the native option is simulated by
> `frontend/mobile/lib/prover/native/NativeProver.ts` using `setTimeout` values
> drawn from Nethermind's public benchmark data for arkworks/BN254 on Android.
> Real native numbers require building the Turbo Module — that is the follow-on
> work if native is chosen.  The stub deliberately uses
> `navigator.hardwareConcurrency` to differentiate single- vs multi-core devices,
> matching the behaviour of Rayon.

### What is measured

| Metric | Source | Notes |
|--------|--------|-------|
| **Proof time (ms)** | `performance.now()` brackets in `lib/prover/bench.ts` | End-to-end wall clock including WASM init on cold run |
| **Peak heap Δ (bytes)** | `performance.memory.usedJSHeapSize` before/after | 0 on Hermes (field absent); available in WebView |
| **App size added** | APK size delta via EAS preview build | Measure before and after adding the dependency |

---

## Benchmark Results

> **Fill this table** by running the spike screen on the target device and
> pasting the exported JSON.  The ranges below are pre-analysis estimates.

### Device: *(device name here)*

| Metric | Option A — WebView | Option B — Native stub |
|--------|-------------------|------------------------|
| Proof time (cold) | *(measure)* | *(measure)* |
| Proof time (warm) | *(measure)* | *(measure)* |
| Peak heap Δ | *(measure — n/a on Hermes)* | *(measure)* |
| App size added | *(measure)* | *(measure)* |

### Pre-analysis estimates (from Nethermind benchmarks + codebase data)

These numbers informed the spike design and the preliminary recommendation.
Replace with measured values above once the spike screen is run on device.

| Metric | Option A — WebView | Option B — Native |
|--------|-------------------|-------------------|
| **Proof time** | 3–8 s | 0.7–2.5 s |
| **Peak memory** | ~150–250 MB | ~80–150 MB |
| **App size added** | ~2 MB (`react-native-webview` + HTML asset) | ~4–6 MB (`.so` per ABI with ABI splits) |
| **Circuit download** | 12 MB on first use | 12 MB on first use (same) |
| **Implementation effort** | 3–4 weeks | 6–8 weeks |
| **Maintenance burden** | Low — follows browser SDK releases | High — native module tracks Rust SDK semver |
| **Battery (inference)** | Higher — longer wall time | Lower — shorter wall time, native threads |
| **Threads** | None (Android <10 WebView, no `SharedArrayBuffer`) | Rayon thread pool (all cores) |
| **SIMD** | None (WebView WASM SIMD off on Android <10) | Full NEON SIMD via Rust target |

Sources:
- `docs/PRIVACY_COST.md` §3 ("3–4 weeks (WebView), or 6–8 weeks (native)")
- Nethermind blog post "Stellar Private Payments" (2026): arkworks multi-core proving times
- `NethermindEth/stellar-private-payments` README v0.1.0-alpha: SDK size and circuit size
- `npm pack --dry-run` on `stellar-private-payments@0.1.0-alpha`: 42 MB tarball (95 MB unpacked)

---

## Decision

> **Recommendation: Option A — WebView first.**

### Reasoning

1. **Proof frequency is low.** A private send is an infrequent, deliberate user action —
   not a latency-sensitive hot path like a scroll or animation.  A proof time of up to
   8 s on the lowest-end devices is acceptable if communicated with a clear progress
   indicator.  Most mid-range devices (Android 12+, Snapdragon 6xx) will prove in < 5 s
   even via WebView.

2. **Time-to-ship matters.** WebView requires 3–4 weeks vs 6–8 weeks for native.  The
   SPP pool is currently testnet-only and unaudited.  Shipping a testnet integration 4
   weeks earlier gives the team more time to discover integration issues before native
   cost is incurred.

3. **The 12 MB circuit download is the dominant UX cost for both options.**  Neither
   approach changes the on-first-use download experience, which is a larger UX problem
   than the 2–6 s proof time delta between options.

4. **Reversible.** The WebView prover is isolated behind a `ProverWebViewHandle` ref
   interface (see `lib/prover/webview/index.ts`).  Swapping in a real native module
   requires changing only the implementation of `proveWebView` — the benchmark screen,
   bench harness, and types all stay the same.

5. **App size.** Adding `react-native-webview` costs ~2 MB vs 4–6 MB for a compiled
   native `.so`.  For a consumer wallet app where download size affects install rates,
   this is a non-trivial difference.

### When to reconsider

Re-open this decision and prioritise the native module if **any** of the following are
true after running real device measurements:

- [ ] Proof time on the named target device exceeds **8 s** on the WebView path.
- [ ] The WebView approach causes **OOM crashes** on 3 GB RAM devices (circuit + WASM
      heap exceeds available memory).
- [ ] Users report the proof spinner as unacceptable in user research / beta feedback.
- [ ] A native module becomes available in the SPP SDK's official React Native bindings
      (Nethermind has signalled this is planned).

---

## Consequences

### Option A — WebView (chosen)

**Positive**
- Faster to ship: 3–4 weeks vs 6–8 weeks.
- Smaller binary: ~2 MB vs ~4–6 MB.
- Browser SDK updates propagate without a native module rebuild.
- No Rust cross-compilation toolchain required in CI.
- Reversible: the interface boundary makes a future native swap low-risk.

**Negative / Trade-offs**
- Slower proof: 3–8 s (WebView WASM) vs 0.7–2.5 s (native Rayon).
- No SIMD or threading in Android < 10 WebViews — performance ceiling is lower.
- WebView process is an extra memory consumer even when idle.
- `react-native-webview` is a new native dependency that must be tracked.
- The hidden WebView pattern is unusual; future contributors need to understand it.

### Option B — Native module (not chosen at this time)

**Positive**
- 3–5× faster proof time via Rayon parallelism and NEON SIMD.
- Lower peak memory (no WebView overhead).
- Better battery efficiency (shorter wall time).

**Negative / Trade-offs**
- 2–4 more weeks to implement.
- Larger binary (~4–6 MB vs ~2 MB).
- Requires Rust cross-compilation (`aarch64-linux-android`, `armeabi-v7a`) in CI.
- Native module must be versioned with the Rust SDK — breakage risk on upstream updates.
- EAS Build configuration changes required.

---

## Alternatives Considered

| Alternative | Why rejected |
|-------------|-------------|
| **Polyfill WASM into Hermes** | Hermes does not expose a WASM host; a userland WASM interpreter (e.g. `wasm3`) would be too slow (~100× vs native WASM) and add megabytes of JS |
| **Run the prover server-side** | Centralises trust, requires a new backend service, and means the user's private note commitment leaves the device — defeats the privacy model |
| **Defer privacy entirely** | SPP is testnet-only and this is a research spike; deferral is always an option, but the spike's goal is to derisk the decision before the SCF Tranche 2 timeline |
| **Use Expo Go** | Expo Go does not support custom native modules; a dev client is required in both cases, so this is not a differentiator |

---

## Related

- `docs/PRIVACY_COST.md` — full cost analysis for SPP integration
- `docs/adr/0001-two-account-model.md` — wallet architecture context
- `frontend/mobile/lib/prover/` — spike implementation
- `frontend/mobile/app/(tabs)/prover-spike.tsx` — benchmark screen
- [NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments) — upstream SDK
- Issue [#720](https://github.com/Miracle656/veil/issues/720)
