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

set -euo pipefail

# Pinned build image. Matches contracts/rust-toolchain.toml (channel 1.85.0).
# Pin to a digest for the strongest guarantee; the tag is used here for clarity.
BUILD_IMAGE="${VEIL_BUILD_IMAGE:-rust:1.85.0-bookworm}"
TARGET="wasm32-unknown-unknown"

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

build_in_docker() {
  # Mount at a fixed path so embedded source paths are stable across machines.
  docker run --rm \
    -v "$REPO_ROOT":/work \
    -w /work/contracts \
    -e CARGO_HOME=/usr/local/cargo \
    "$BUILD_IMAGE" \
    bash -euo pipefail -c '
      rustup target add '"$TARGET"' >/dev/null 2>&1 || true
      cargo build --release --locked --target '"$TARGET"'
    '
}

build_on_host() {
  ( cd "$REPO_ROOT/contracts"
    rustup target add "$TARGET" >/dev/null 2>&1 || true
    cargo build --release --locked --target "$TARGET" )
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
  done | sort -k2 | python3 -c '
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
  python3 - "$HASHES_FILE" <<PY
import json, sys
artifacts = json.loads('''$COMPUTED''')
doc = {
    "_comment": "SHA-256 of release wasm artifacts. Regenerate with scripts/reproducible-build.sh --update.",
    "toolchain": "1.85.0",
    "image": "$BUILD_IMAGE",
    "target": "$TARGET",
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

python3 - "$HASHES_FILE" <<PY
import json, sys
computed = json.loads('''$COMPUTED''')
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
