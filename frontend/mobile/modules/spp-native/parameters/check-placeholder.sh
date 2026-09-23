#!/usr/bin/env bash
#
# Fails when parameters/proving-key.bin is still the placeholder.
#
# The placeholder exists only so `cargo check`/`cargo test` resolve the
# include_bytes! without the real 30 MB key checked in during development.
# Any build that will actually prove must run generate-key.sh first, and the
# key-generation step itself calls this as a guard — so a placeholder can
# never silently reach a device, where proving would fail at runtime with
# "embedded proving key unreadable".
set -euo pipefail

KEY="$(dirname "$0")/proving-key.bin"
if ! [ -f "$KEY" ]; then
  echo "error: $KEY missing — run generate-key.sh first" >&2
  exit 1
fi
if head -c 40 "$KEY" | grep -q "PLACEHOLDER"; then
  echo "error: $KEY is still the placeholder — run generate-key.sh and commit the real key" >&2
  exit 1
fi
echo "proving key present"
