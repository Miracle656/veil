# SPP parameters — proving key.
#
# `parameters/proving-key.bin` holds the Groth16 proving key for the V142
# circuit, generated once by:
#
#   cd rust/spp-prover
#   cargo test --release generate_key_fixture -- --ignored
#
# The key is committed because EAS builds must not depend on a network
# fetch (or on a contributor's machine having the ceremony output) — the
# APK carries the key inside the .so, so proving works offline from install.
#
# The binary is large; `git lfs` is not required, but `.gitattributes`
# marks it binary so diffs never try to render it.
