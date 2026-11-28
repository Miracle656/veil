---
'invisible-wallet-sdk': patch
---

Fix signing on Protocol 30 networks. With `@stellar/stellar-sdk` 15.1.0, `rpc.Server.getLatestLedger()` throws "XDR Read Error: unknown StellarValueType member for value 3" on mainnet and testnet, because it decodes a ledger header newer than it understands. The SDK called it while signing an authorization entry, so every passkey-signed transaction failed. The latest ledger sequence is now read through a helper that falls back to the plain JSON-RPC reply when the header cannot be decoded.
