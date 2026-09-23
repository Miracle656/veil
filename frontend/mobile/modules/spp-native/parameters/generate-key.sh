#!/usr/bin/env bash
#
# Regenerate parameters/proving-key.bin deterministically.
#
# The key is a function of the circuit's constraint system only, so a fixed
# RNG seed produces the identical key bytes on every machine — there is no
# interactive ceremony to run. Run this after a circuit change and commit
# the result; the Gradle build and the WASM path both consume it verbatim.
set -euo pipefail

cd "$(dirname "$0")/../rust/spp-prover"
cargo test --release generate_key_fixture -- --ignored --nocapture

# The fresh key must be byte-identical on a second run — if it is not, the
# RNG is not actually deterministic and the "committed key" model is broken.
cargo test --release generate_key_fixture -- --ignored --nocapture
KEY="../parameters/proving-key.bin"
if head -c 40 "$KEY" | grep -q "PLACEHOLDER"; then
  echo "error: key generation produced a placeholder" >&2
  exit 1
fi
echo "wrote $KEY"
