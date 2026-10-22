---
"invisible-wallet-sdk": minor
---

`@stellar/stellar-sdk` moves from `dependencies` to `peerDependencies` (`^17.0.1`),
so an app using the SDK installs one copy of the XDR tables instead of two. Apps must
now depend on `@stellar/stellar-sdk` 17 themselves — `npm install @stellar/stellar-sdk`
alongside the SDK. The passkey authorisation path was rebuilt for protocol 23's
CAP-71 `ADDRESS_V2` credential arm and verified with a real spend on testnet.
