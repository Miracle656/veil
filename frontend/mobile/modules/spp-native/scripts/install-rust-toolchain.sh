#!/usr/bin/env sh
# Install a Rust toolchain for the spp-native Gradle build.
#
# EAS Android images ship the NDK but not Rust (see the "Android server
# images" list in expo.dev/build-reference/infrastructure), while the module's
# Gradle graph shells out to `cargo ndk` per ABI. EAS runs this script through
# the `eas-build-post-install` npm hook, after dependency install and before
# prebuild/Gradle, so the tasks find cargo when they run. On GitHub Actions
# the mobile-e2e workflow installs the toolchain before `npm ci`, so this
# short-circuits to adding the Android targets + cargo-ndk.
#
# Visibility detail that is easy to get wrong: installing into ~/.cargo puts
# `cargo` on this script's PATH only — the Gradle daemon runs later with the
# image's stock PATH and would not find it. So after installing, the toolchain
# binaries are linked into /usr/local/bin when writable (EAS VMs run as root);
# with sudo when available (GitHub runners); otherwise a loud warning — the
# Gradle tasks then skip (module design: no cargo ⇒ no Rust, app falls back
# to WASM) instead of failing a build that never needed them.
#
# Safe to run repeatedly: a working cargo short-circuits to just the targets
# and cargo-ndk. Non-Linux hosts (EAS iOS) exit 0; the module skips its Rust
# tasks there until the iOS target ships.

set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "[spp-native] not Linux — skipping Rust toolchain install"
  exit 0
fi

TARGETS="aarch64-linux-android armv7-linux-androideabi x86_64-linux-android"
CARGO_NDK_VERSION="4.1.2"

# Prefer the pinned version; fall back to the latest available one if the pin
# disappears (cargo-ndk 3.5.7 was yanked from crates.io mid-flight and broke
# a CI run at exactly this step).
install_cargo_ndk() {
  if cargo ndk --version >/dev/null 2>&1; then
    return 0
  fi
  if ! cargo install cargo-ndk --locked --version "$CARGO_NDK_VERSION"; then
    echo "[spp-native] cargo-ndk $CARGO_NDK_VERSION unavailable (yanked?) — installing the latest release instead"
    cargo install cargo-ndk --locked
  fi
}

if command -v cargo >/dev/null 2>&1; then
  echo "[spp-native] cargo already available: $(cargo --version)"
  rustup target add $TARGETS
  install_cargo_ndk
  exit 0
fi

export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"

echo "[spp-native] installing Rust (stable, minimal profile) into $CARGO_HOME"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path

export PATH="$CARGO_HOME/bin:$PATH"
rustup target add $TARGETS
install_cargo_ndk

linked=0
for bin in "$CARGO_HOME"/bin/*; do
  name="$(basename "$bin")"
  if [ -w /usr/local/bin ] && ln -sf "$bin" "/usr/local/bin/$name" 2>/dev/null; then
    linked=1
  elif command -v sudo >/dev/null 2>&1 && sudo ln -sf "$bin" "/usr/local/bin/$name" 2>/dev/null; then
    linked=1
  fi
done

if [ "$linked" -eq 1 ]; then
  echo "[spp-native] Rust toolchain ready: $(cargo --version), $(cargo ndk --version)"
else
  echo "[spp-native] WARNING: could not link $CARGO_HOME/bin onto the system PATH." \
    "Gradle will not find cargo and will build without the native prover" \
    "(JS falls back to WASM). Install Rust manually and re-run to fix."
fi
