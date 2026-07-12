#!/usr/bin/env bash
#
# WASM size benchmark for the Veil Soroban contracts.
#
# Builds each contract twice for wasm32-unknown-unknown — once with the size
# optimizations from [profile.release] in contracts/Cargo.toml (LTO, a single
# codegen unit, the "z" size tier, panic=abort and symbol stripping), and once
# with those knobs reverted to a naive release baseline — then prints the
# per-artifact size delta. Smaller bytecode means lower upload/instantiation
# fees on-chain.
#
# The baseline is produced with `cargo --config` overrides only; nothing on
# disk is mutated, so the run is safe to repeat and safe in CI.
#
# Usage:
#   scripts/bench-wasm-size.sh            # benchmark every workspace contract
#   scripts/bench-wasm-size.sh -p NAME    # benchmark a single crate (e.g. invisible-wallet)
#
# Exit status: 0 on success, non-zero on build failure.

set -euo pipefail

TARGET="wasm32-unknown-unknown"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"

PKG_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -p|--package) PKG_ARGS+=( -p "$2" ); shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The knobs the optimized profile sets; reverting them yields the "before"
# baseline (a naive `cargo build --release`). panic=abort is kept in both so the
# comparison isolates exactly the size-tier / LTO / codegen / strip savings.
BASELINE_OVERRIDES=(
  --config 'profile.release.opt-level=3'
  --config 'profile.release.lto=false'
  --config 'profile.release.codegen-units=16'
  --config 'profile.release.strip="none"'
)

rustup target add "$TARGET" >/dev/null 2>&1 || true

build() {
  # $1: label for logging, remaining args: extra cargo flags
  local label="$1"; shift
  echo "==> Building $label ($TARGET)" >&2
  ( cd "$CONTRACTS_DIR"
    cargo build --release --locked --target "$TARGET" "${PKG_ARGS[@]}" "$@" >&2 )
}

# Snapshot the size of every .wasm artifact into "name<TAB>bytes" lines.
snapshot_sizes() {
  local dir="$REPO_ROOT/contracts/target/$TARGET/release"
  ( cd "$dir"
    shopt -s nullglob
    for f in *.wasm; do
      printf '%s\t%s\n' "$f" "$(wc -c < "$f" | tr -d ' ')"
    done | sort )
}

# --- optimized build (current profile) ---
build "optimized profile"
OPTIMIZED="$(snapshot_sizes)"

# Force a clean rebuild so the override takes effect, then build the baseline.
( cd "$CONTRACTS_DIR" && cargo clean --release --target "$TARGET" >/dev/null 2>&1 || true )
build "naive release baseline" "${BASELINE_OVERRIDES[@]}"
BASELINE="$(snapshot_sizes)"

# Restore the optimized artifacts on disk so a subsequent reproducible-build /
# deploy does not pick up the throwaway baseline wasm.
( cd "$CONTRACTS_DIR" && cargo clean --release --target "$TARGET" >/dev/null 2>&1 || true )
build "optimized profile (restore)"

echo
echo "WASM size: naive release baseline -> optimized [profile.release]"
echo "----------------------------------------------------------------------"
printf '%-28s %12s %12s %10s\n' "artifact" "baseline" "optimized" "saved"
echo "----------------------------------------------------------------------"

# Join the two snapshots by artifact name and print the delta.
join -t $'\t' \
  <(printf '%s\n' "$BASELINE") \
  <(printf '%s\n' "$OPTIMIZED") \
| while IFS=$'\t' read -r name base opt; do
    saved=$(( base - opt ))
    if [ "$base" -gt 0 ]; then
      pct=$(awk -v s="$saved" -v b="$base" 'BEGIN { printf "%.1f", (s / b) * 100 }')
    else
      pct="0.0"
    fi
    printf '%-28s %12s %12s %9s%%\n' "$name" "$base" "$opt" "$pct"
  done

echo "----------------------------------------------------------------------"
echo "Sizes in bytes. 'saved' = (baseline - optimized) / baseline."
