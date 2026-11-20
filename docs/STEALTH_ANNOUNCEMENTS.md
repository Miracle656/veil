# Stellar stealth announcements

The `stealth-announcer` Soroban contract is a stateless event transport. Its
`announce` function emits a version-1 payload containing a 32-byte ephemeral
public key and a sealed note. The one-byte view tag is a separate indexed
topic, so RPC can filter announcements before the receiver performs the full
key derivation. The SDK's `readStealthAnnouncements` helper reads and paginates
these events from a chosen ledger.

## Event topics and privacy

The event has exactly two topics: the constant `announce` discriminator and the
one-byte view tag. The discriminator is identical for every payment and cannot
identify a receiver. A sender derives the view tag from the per-payment shared
secret and uses a fresh ephemeral key for each payment, so a receiver's tags
are not a stable cross-payment identifier. An observer without a receiver's
secret sees a uniformly distributed byte, with a 1-in-256 chance of a match
for any one announcement. Neither topic contains a receiver address or a
receiver-correlated public key. Version, ephemeral key, and sealed note are
event data, not indexed topics.

The contract does not store announcements, accept a token/address, or invoke a
token contract. It cannot custody or move payment funds. The RPC node retains
only a bounded event history, so clients should scan frequently and persist
their own cursor or last processed ledger.

## Read from the SDK

```ts
import { readStealthAnnouncements } from 'invisible-wallet-sdk/stealth-announcements';

const announcements = await readStealthAnnouncements({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  contractId: 'FULL_56_CHARACTER_CONTRACT_ID',
  startLedger: 123456,
  viewTag: 42,
});
```

The helper rejects unsupported payload versions rather than interpreting them
as version 1. `startLedger` must be inside the RPC node's retained ledger range.
