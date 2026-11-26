---
"invisible-wallet-sdk": patch
---

Allow bundlers to discard unused SDK modules while retaining Angular runtime
initialization. Carry the side-effect exceptions into the generated ESM package
scope and isolate Stellar-dependent wallet address derivation so small utility
imports do not include the wallet or its dependencies. Public exports and address
derivation are unchanged.
