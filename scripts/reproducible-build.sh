#!/usr/bin/env bash
#
# Reproducible WASM build & hash verification for the Veil contracts.
#
# Builds the Soroban contracts in a pinned, deterministic environment, computes
# the SHA-256 of each release .wasm artifact, and either checks them against the
# committed contracts/expected-hashes.json (default) or regenerates that file.
#
# Determinism strategy
# --------------------
# By default the build runs inside a pinned Docker image with the repository
# mounted at a FIXED path (/work) and a fixed CARGO_HOME, so the absolute paths
# rustc embeds are identical on every machine — including GitHub Actions. The
# toolchain version is pinned by contracts/rust-toolchain.toml and dependencies
# by contracts/Cargo.lock (built with --locked). A third party who runs this
# script with the same image gets byte-identical wasm and therefore the same
# hashes.
#
# Usage:
#   scripts/reproducible-build.sh            # build + check against committed hashes
#   scripts/reproducible-build.sh --update   # build + (re)write expected-hashes.json
#   scripts/reproducible-build.sh --no-docker # use the host toolchain instead of Docker
#
# Exit status: 0 on success / match, non-zero on build failure or hash drift.

set -Eeuo pipefail

trap 'echo "::error::reproducible-build.sh failed at line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# Pinned build image. Matches contracts/rust-toolchain.toml (channel 1.85.0).
# Pinned to an immutable multi-arch digest for byte-for-byte reproducibility.
BUILD_IMAGE="${VEIL_BUILD_IMAGE:-rust:1.85.0-bookworm@sha256:0ff31c9ffa641a62e48d543fb00b4960955ea375f40776f40f585b89e654cc5e}"
TARGET="wasm32-unknown-unknown"
PYTHON_BIN="${PYTHON_BIN:-python3}"

MODE="check"
USE_DOCKER=1
for arg in "$@"; do
  case "$arg" in
    --update)    MODE="update" ;;
    --check)     MODE="check" ;;
    --no-docker) USE_DOCKER=0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Resolve repo root (this script lives in scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HASHES_FILE="$REPO_ROOT/contracts/expected-hashes.json"

echo "==> Building contracts ($TARGET, release)"

# Each workspace member is built in its own `cargo build -p` invocation, never
# all of them in one.
#
# `cargo build` with no `-p` builds every member together, and Cargo unifies
# features across everything in a single invocation — so adding an unrelated
# member silently changes what the others compile to. Measured on #1328:
# adding `contracts/veil-names`, which pulls `stellar-tokens`, moved
# `invisible_wallet.wasm`, `multisig_wallet.wasm` and `vault.wasm` while
# touching none of their source. Built per package, all three stay
# byte-identical and only the new artifact appears.
#
# That matters because of the question this script exists to answer: a
# contract's hash has to be a property of that contract's source, not of
# whatever else happens to share its workspace. Otherwise "this hash came from
# this source" stops being true, and the review heuristic that more than one
# hash moving for a single-contract change is suspicious stops working.
#
# Cost is near zero — the members share a target directory, so dependencies
# compile once and the later packages reuse them.
#
# The member list is read from Cargo.toml rather than hardcoded so a new
# contract is picked up automatically, and each member's *package* name is read
# from its own manifest because the two differ (`invisible_wallet/` holds the
# package `invisible-wallet`, which `-p invisible_wallet` would not match).
BUILD_EACH_MEMBER='
  members=$(sed -n "/^members = \[/,/^\]/p" Cargo.toml \
    | sed -n "s/^[[:space:]]*\"\([^\"]*\)\",*[[:space:]]*\$/\1/p")
  [ -n "$members" ] || { echo "No workspace members in contracts/Cargo.toml" >&2; exit 1; }
  for m in $members; do
    pkg=$(sed -n "s/^name = \"\([^\"]*\)\".*/\1/p" "$m/Cargo.toml" | head -1)
    [ -n "$pkg" ] || { echo "No package name in $m/Cargo.toml" >&2; exit 1; }
    echo "    -> $pkg"
    cargo build --release --locked --target "$WASM_TARGET" -p "$pkg"
  done
'

build_in_docker() {
  # Mount at a fixed path so embedded source paths are stable across machines.
  docker run --rm \
    -v "$REPO_ROOT":/work \
    -w /work/contracts \
    -e CARGO_HOME=/usr/local/cargo \
    -e WASM_TARGET="$TARGET" \
    "$BUILD_IMAGE" \
    bash -euo pipefail -c '
      rustup target add "$WASM_TARGET" >/dev/null 2>&1 || true
      '"$BUILD_EACH_MEMBER"'
    '
}

build_on_host() {
  ( cd "$REPO_ROOT/contracts"
    export WASM_TARGET="$TARGET"
    rustup target add "$WASM_TARGET" >/dev/null 2>&1 || true
    eval "$BUILD_EACH_MEMBER" )
}

if [ "$USE_DOCKER" -eq 1 ]; then
  echo "    using pinned image: $BUILD_IMAGE"
  build_in_docker
else
  echo "    using host toolchain (ensure it matches contracts/rust-toolchain.toml)"
  build_on_host
fi

WASM_DIR="$REPO_ROOT/contracts/target/$TARGET/release"
echo "==> Hashing artifacts in $WASM_DIR"

# Build a JSON object { "<file>.wasm": "<sha256>", ... } sorted by filename.
COMPUTED="$(
  cd "$WASM_DIR"
  shopt -s nullglob
  files=( *.wasm )
  if [ ${#files[@]} -eq 0 ]; then
    echo "No .wasm artifacts produced — build may have failed." >&2
    exit 1
  fi
  for f in "${files[@]}"; do
    printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"
  done | sort -k2 | "$PYTHON_BIN" -c '
import sys, json
out = {}
for line in sys.stdin:
    digest, name = line.split()
    out[name] = digest
print(json.dumps(out, indent=2, sort_keys=True))
'
)"

echo "$COMPUTED"

if [ "$MODE" = "update" ]; then
  "$PYTHON_BIN" - "$HASHES_FILE" "$COMPUTED" "$BUILD_IMAGE" "$TARGET" <<'PY'
import json, sys
artifacts = json.loads(sys.argv[2])
doc = {
    "_comment": "SHA-256 of release wasm artifacts. Regenerate with scripts/reproducible-build.sh --update.",
    "toolchain": "1.85.0",
    "image": sys.argv[3],
    "target": sys.argv[4],
    "artifacts": artifacts,
}
with open(sys.argv[1], "w") as fh:
    fh.write(json.dumps(doc, indent=2, sort_keys=True) + "\n")
print("==> Wrote", sys.argv[1])
PY
  exit 0
fi

# --- check mode ---
if [ ! -f "$HASHES_FILE" ]; then
  echo "ERROR: $HASHES_FILE not found. Seed it with: scripts/reproducible-build.sh --update" >&2
  exit 1
fi

"$PYTHON_BIN" - "$HASHES_FILE" "$COMPUTED" <<'PY'
import json, sys
computed = json.loads(sys.argv[2])
with open(sys.argv[1]) as fh:
    expected = json.load(fh).get("artifacts", {})

if not expected:
    print("ERROR: expected-hashes.json has no artifacts; seed it with --update", file=sys.stderr)
    sys.exit(1)

ok = True
for name in sorted(set(expected) | set(computed)):
    exp = expected.get(name)
    got = computed.get(name)
    if exp == got:
        print(f"  OK   {name}  {got}")
    else:
        ok = False
        print(f"  DRIFT {name}\n        expected {exp}\n        got      {got}", file=sys.stderr)

if not ok:
    print("\nHash drift detected. If this change is intentional, regenerate with\n  scripts/reproducible-build.sh --update\nand commit contracts/expected-hashes.json.", file=sys.stderr)
    sys.exit(1)
print("\n==> All wasm hashes match the committed expected-hashes.json")
PY

echo "==> Reproducible build checks passed."
exit 0
