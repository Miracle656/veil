---
"invisible-wallet-sdk": minor
---

Accept CAP-84 muxed contract (`W…`) addresses as destinations.

`isValidDestination` and the SEP-7 helpers now use `StrKey.isValidMuxedContract`
instead of rejecting every address that is not a `G…` or `C…` account. A `W…`
address is a valid contract destination, not an invalid account, and callers can
route it through a SAC transfer (SDK 17's `addSacTransferOperation`).
