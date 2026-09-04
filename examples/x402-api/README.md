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

(passkey tap → sign 0.01 XLM payment with the exact Stellar scheme)

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

## Acceptance criteria

- **API returns 402 when unpaid** — `curl` above, or the client's first request.
- **Client pays via Veil, returns 200** — the "Get quote" button signs the 0.01
  XLM payment with the Veil wallet and renders the unlocked `200` response.

## Notes

- Amounts are denominated in **XLM** by passing an explicit `AssetAmount`
  (native asset SAC + stroops) as the price, rather than a `"$0.01"` money
  string, which the scheme would otherwise resolve to USDC.
- The fee-payer key is generated and funded client-side purely to keep the
  example self-contained; the passkey is what gates every spend. Production
  integrations should hold the spending key in the Veil wallet contract.
- This is testnet-only sample code and has not been audited. Do not reuse the
  key-handling shortcuts on mainnet.
