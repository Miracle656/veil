#!/usr/bin/env bash
#
# Do not generate proving parameters in Veil.
#
# SPP publishes the proving artifacts for its canonical circuits. A locally
# generated key would not match the deployed SPP verifier.
set -euo pipefail

echo "error: Veil never generates SPP proving keys; install the artifact published by the pinned SPP commit" >&2
exit 2
