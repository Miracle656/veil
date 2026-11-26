---
"invisible-wallet-sdk": patch
---

Add `repository`, `homepage`, `bugs` and `engines` to the published manifest, so
the npm page links back to the source, the SDK reference and the issue tracker.
`engines.node` is `>=20`, the version every CI job that builds or tests the SDK
runs on. `repository` carries `directory: "sdk"`, which npm provenance needs to tie
a published build to the commit that produced it.
