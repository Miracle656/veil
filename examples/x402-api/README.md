# Veil × x402 Micropayment API

[x402](https://x402.org) is the HTTP `402 Payment Required` standard for paying
per-request with onchain money. It is a natural fit for Veil's invisible-wallet
UX: the user taps a passkey once and the payment happens behind the scenes.

This example wires both halves of the flow on **Stellar testnet**:

| Part | Stack | What it does |
|---|---|---|
| [`server/`](./server) | Express + `@x402/core` + `@x402/stellar` | Guards `GET /paid/quote` behind a **0.01 XLM** charge. Returns **402** when unpaid; verifies and **settles on-chain**, then returns **200**. |
| [`client/`](./client) | Next.js + `@x402/stellar` + Veil passkey | Calls the API, signs the 0.01 XLM payment with the Veil wallet key after a biometric tap, and renders the unlocked response. |

The server is **both** the x402 *resource server* and the x402 *facilitator*, so
the demo runs end-to-end with a single funded testnet key — no third-party
facilitator required. (`server/src/x402.ts` shows how to swap in a remote
facilitator instead.)

## How the flow works

```
Next.js client                         Express x402 server
──────────────                         ───────────────────
GET /paid/quote ───────────────────▶   no X-PAYMENT header
                ◀───────────────────   402 Payment Required + requirements (0.01 XLM)

(challenge = SHA-256(network, asset, amount, payTo, resource, timeout)
 → passkey tap over that challenge → assertion verified locally
 → sign 0.01 XLM payment with the exact Stellar scheme)

GET /paid/quote                        verify payment
  PAYMENT-SIGNATURE: <payload> ────▶   settle on Stellar (facilitator sponsors the fee)
                ◀───────────────────   200 OK + data + PAYMENT-RESPONSE receipt
```

## Prerequisites

- Node.js 18+
- A funded **Stellar testnet** account for the facilitator. Generate a keypair
  and fund it from Friendbot:
  ```bash
  # any tool that prints a G…/S… pair works; e.g. the Stellar Lab
  curl "https://friendbot.stellar.org/?addr=<YOUR_G_PUBLIC_KEY>"
  ```

## Run it

### 1. Start the API server

```bash
cd server
npm install
cp .env.example .env
#   → set FACILITATOR_SECRET to your funded testnet secret (S…)
npm run dev          # http://localhost:4021
```

Confirm the gate returns **402** before any payment:

```bash
curl -i http://localhost:4021/paid/quote
# HTTP/1.1 402 Payment Required
# { "x402Version": ..., "accepts": [ { "scheme": "exact", "network": "stellar:testnet", ... } ] }
```

### 2. Start the client

```bash
cd ../client
npm install
cp .env.example .env.local
npm run dev          # http://localhost:3000
```

Open <http://localhost:3000>, **Create Veil wallet** (registers a passkey and
funds a fee-payer key from Friendbot), then **Get quote — pay 0.01 XLM with
Veil**. After the biometric tap the client pays and the quote appears with a
`200 OK`.

## What the passkey prompt does and does not guarantee

The WebAuthn challenge is **derived from the payment**, not random
(`client/src/lib/challenge.ts`): a SHA-256 over the network, asset, amount,
recipient, resource URL and validity window from the server's 402 requirements.
The client verifies the returned assertion (challenge, user presence + user
verification, ES256 signature against the passkey public key stored at
registration) **before** it signs, and refuses to sign if the payload it built
differs from the requirement the user approved. The verified assertion is
returned with the response and shown in the UI as the record of what was
approved. Tests (`npm test` in `client/`) prove a different payment yields a
different challenge and that a random-challenge or wrong-payment assertion is
rejected.

What it **does** provide: a biometric approval that is cryptographically tied to
*this* amount, *this* recipient and *this* network, checked before signing.

What it does **not** provide: the Stellar transaction is still signed by the
fee-payer key held in `localStorage`, and neither the server nor the chain
checks the passkey assertion. Malicious code running in the page could read
that key and pay without any prompt. The passkey is a consent gate, not the
authorisation the network enforces. To make the passkey signature *be* the
authorisation, route the payment through the Veil wallet contract's
`__check_auth` ceremony (as `frontend/mobile`'s `signXdrPayload()` does); this
example does not do that.

### Payment validity window

The server sets `maxTimeoutSeconds: 120` (~24 ledgers). The Veil wallet's own
`__check_auth` signatures expire 100 ledgers (~500 s) out. The difference is
intentional: a 0.01 XLM call needs a much shorter window. It is a named
constant (`MAX_TIMEOUT_SECONDS` in `server/src/x402.ts`) and is part of the
passkey challenge, so changing it changes what the user approves.

## Acceptance criteria

- **API returns 402 when unpaid** — `curl` above, or the client's first request.
- **Client pays via Veil, returns 200** — the "Get quote" button signs the 0.01
  XLM payment with the Veil wallet and renders the unlocked `200` response.

## Notes

- Amounts are denominated in **XLM** by passing an explicit `AssetAmount`
  (native asset SAC + stroops) as the price, rather than a `"$0.01"` money
  string, which the scheme would otherwise resolve to USDC.
- The fee-payer key is generated and funded client-side purely to keep the
  example self-contained; the passkey gates every spend (see the section
  above for exactly what that means). Wallets created before the passkey
  public key was stored are treated as not set up; create a new one. Production
  integrations should hold the spending key in the Veil wallet contract.
- This is testnet-only sample code and has not been audited. Do not reuse the
  key-handling shortcuts on mainnet.
