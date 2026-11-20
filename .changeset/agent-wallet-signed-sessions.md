---
'@veil/agent': minor
---

Bind agent requests to a wallet-signed session instead of a claimed address. The route issues a single-use challenge, the client signs it with its passkey through the existing VEIL_SIGNED_MESSAGE_V1 path, and chat/clear_history resolve the wallet address from the verified session. Retires the legacy WebSocket server whose history was keyed by a client-supplied address.
