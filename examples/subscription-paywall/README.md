# Subscription Paywall (Next.js)

A recurring **on-chain subscription paywall** built on the
[`invisible-wallet-sdk`](../../sdk). Users create a passkey wallet, unlock premium
content with a single **recurring payment authorization**, and Next.js middleware
gates the premium routes based on the subscription status **read from chain**.

## How it works

The subscription is a Soroban **token allowance** from the user's wallet contract
to a merchant address, with an expiry:

| Action | SDK / chain call | Meaning |
| --- | --- | --- |
| **Unlock** | `wallet.approve(feePayer, merchant, token, price, expiry)` | Authorize the merchant to pull up to `price` until `expiry` — the recurring payment authorization, confirmed with the user's passkey. |
| **Status** | `get_allowance(merchant, token)` (read-only simulation) | The subscription is **active** while the wallet has a positive, unexpired allowance to the merchant. |
| **Renew** | `approve(...)` again | Extends the authorization for another period. |

Because the status is a read-only Soroban simulation, it works on the **client**
(`useInvisibleWallet().getAllowance`) and on the **server**
(`src/lib/subscription.ts` → used by the API route and middleware) alike.

## Routes

| Route | Access | Description |
| --- | --- | --- |
| `/` | Free | Landing page + passkey wallet creation. |
| `/paywall` | Free | Shows on-chain subscription status and the **Unlock** button. |
| `/premium` | Paid | Gated content. `middleware.ts` redirects here-or-away based on subscription status; the page server-component re-verifies from chain. |
| `/api/subscription` | — | Node route that reads the subscription status from chain. |

### Gating

- **`middleware.ts`** matches `/premium/:path*`. It reads the wallet address from
  a cookie, asks `/api/subscription` (which reads the on-chain allowance) whether
  the subscription is active, and redirects to `/paywall` when it is not. The
  Stellar SDK stays out of the Edge runtime — the middleware only fetches the Node
  route.
- **`src/app/premium/page.tsx`** is a server component that re-reads the
  subscription from chain on render as an authoritative second check.

## Setup

```bash
# 1. Build the SDK (once)
cd ../../sdk && npm install && npm run build

# 2. Install and configure this example
cd ../examples/subscription-paywall
npm install
cp .env.example .env.local
```

Set `NEXT_PUBLIC_MERCHANT_ADDRESS` in `.env.local` to any Stellar address you
control (a `G…` account or `C…` contract) — this is the subscription's payee. The
remaining testnet defaults work out of the box; the token defaults to native XLM.

```bash
npm run dev
```

Open http://localhost:3000 (WebAuthn requires `localhost` or HTTPS).

## Try it

1. **`/`** — create a passkey wallet (registers, funds a fee-payer via Friendbot,
   deploys the wallet contract).
2. Visit **`/premium`** — the middleware redirects you to `/paywall` (no active
   subscription).
3. **`/paywall`** — click **Unlock** and confirm with your passkey. This authorizes
   the recurring payment on-chain.
4. **`/premium`** — you now have access; the page shows when it expires.

## Acceptance criteria

- ✅ **Free vs paid routes** — `/` and `/paywall` are open; `/premium` is gated by
  `middleware.ts` + a server-side re-check.
- ✅ **Subscription status read from chain** — `get_allowance` is simulated against
  the wallet contract in `src/lib/subscription.ts` (server) and via the SDK on the
  client.

## Notes

- The fee-payer keypair is generated and funded client-side for the demo; in
  production you would sponsor fees server-side.
- For a calendar-style subscription, a scheduled job would `transfer` from the
  allowance each period; here the allowance + expiry models the authorization and
  access window.
