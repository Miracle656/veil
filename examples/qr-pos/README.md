# Veil QR Point of Sale

A tablet-friendly merchant terminal: enter an amount, show a **SEP-7 `pay` QR**,
and watch for the on-chain payment — the customer scans it with their Veil
wallet and the screen flips to **Paid!**.

The merchant side is pure SEP-7 + Horizon, so it needs no keys and never signs
anything. The pay request is a `web+stellar:pay` URI in the same shape the Veil
wallet's SDK builds and parses, so any SEP-7 wallet — Veil included — can scan
it.

## Flow

1. **Enter a charge** — receiving account (`G…`), amount, and (optionally) a
   custom asset code + issuer. Blank asset = XLM.
2. **Show the QR** — a `web+stellar:pay?…` URI with a unique memo is encoded as a
   QR. The customer scans it in the Veil wallet and approves.
3. **Detect payment** — the app polls Horizon's `payments` endpoint for the
   merchant account and matches on destination, asset, amount, and timestamp
   (and the memo when the wallet echoes it), then shows **Paid!** with a link to
   the transaction.

## Run

```bash
cd examples/qr-pos
npm install
npm run dev   # http://localhost:5174
```

Defaults target **testnet**. To point elsewhere, copy `.env.example` to `.env`
and set `VITE_HORIZON_URL`, `VITE_NETWORK_PASSPHRASE`, and/or
`VITE_MERCHANT_ADDRESS`.

## Notes

- Matching uses amount + asset + recency, with the SEP-7 memo as an extra check
  when the paying wallet includes it. For production, prefer a unique memo per
  charge and verify it server-side.
- `npm run build` runs `tsc && vite build`.
