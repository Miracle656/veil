# Veil Connect (pilot)

Lets another web app use a person's Veil wallet without that person installing
anything. The app opens a Veil window; the person creates or unlocks their
wallet there with a passkey; the app gets an answer back.

Status: **pilot**. One partner, small amounts, the interface may change.

## What it does

| Call | The person sees | The app gets |
|---|---|---|
| `connect()` | "Share your wallet address with App?" | `{ address, network }` |
| `pay({...})` | Who is asking, how much, to which address, then Veil's normal Send screen | `{ hash, reference, network, from, memo }` |
| `addMoney()` | "Buy with naira" in Veil | `{ type: 'fund' }` once they are on their way |
| `cashOut()` | "Cash out" in Veil: their own USDC to their own bank, as naira | `{ type: 'cashout' }` once they are on their way |

Each person has their own wallet and passes Veil's own identity check when
they first add naira. Veil never holds the app's money, and the app never
holds a key to the wallet. Every payment is confirmed by the person with their
passkey.

## Using it

```html
<script src="https://app.useveilapp.xyz/connect.js"></script>
<script>
  const veil = VeilConnect.init({ app: 'your-app-id' })

  connectButton.onclick = async () => {
    const { address } = await veil.connect()
  }

  payButton.onclick = async () => {
    const { hash, reference } = await veil.pay({
      to: depositAddress,   // full Stellar address, G… or C…
      amount: '20',         // a string, at most 7 decimals
      asset: 'USDC',        // 'USDC' (default) or 'XLM'
      reference: 'order-123',
    })
    // Send hash + reference to YOUR server and verify there. See below.
  }
</script>
```

- Call from a click or tap. Browsers block a window opened any other way.
- A call rejects with an error whose `code` is `cancelled` (the person closed
  the window or pressed Cancel), `refused` (Veil would not take the request,
  see `message`), or `blocked` (the browser blocked the window).
- One payment may be at most 1000 (USDC or XLM) during the pilot.
- Adding naira gives the person XLM. They swap to USDC inside Veil. Joining
  those into one step is planned, not built.

## You must verify every payment on your server

The result comes from the person's browser. Treat it as a claim. Before you
credit anything:

1. Look the hash up on Stellar, for example
   `GET https://horizon.stellar.org/transactions/<hash>/operations`.
2. Check the transaction succeeded.
3. Check it moved the **right asset** (for USDC, the code `USDC` **and** the
   issuer `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`), the
   **right amount**, **to your address**.
   - If your address is a `G…` account, look for a `payment` operation and
     check its `to`, `asset_code`, `asset_issuer` and `amount`.
   - If your address is a `C…` contract, look for an `invoke_host_function`
     operation and check its `asset_balance_changes` list.
   - **Do not require the sender to be the address `connect()` gave you.**
     That address is the wallet (`C…`). Payments leave from the wallet's
     spending account, a `G…` address, which is `from` in the result. Match
     the payment by where it went, not where it came from.
   - The same transaction can hold a second, smaller payment to another
     address. That is Veil's fee, paid by the person on top of your amount:
     you always receive the full amount you asked for. When it is there it
     comes after your payment, but do not rely on its position or its size.
     The rate can change, and the fee is left out when it cannot be worked
     out. Credit the amount of the payment **to your address** and ignore
     every other operation.
4. Check the transaction's **memo** is a text memo equal to your reference.
   Veil writes the reference there, unchanged, so a hash can only be claimed
   for the order it was paid for. This needs a reference of **28 characters
   or fewer** (a text memo holds no more). A longer reference is not cut to
   fit: no memo is written and `memo` in the result is `null`. Keep references
   short, and keep personal details out of them, because a memo is public.
5. Accept each hash **once**. Store it with the reference and refuse a repeat.
6. Check `network` is `mainnet`.

If any check fails, do not credit.

## Paying out to a Veil wallet

To send a person money (a withdrawal from your app), pay the wallet address
`connect()` gave you. It is a `C…` contract address.

- Send with the USDC token contract's `transfer(from, to, amount)`. On mainnet
  that contract is `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
  (Circle USDC, issuer
  `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`). A classic
  `payment` operation cannot pay a `C…` address.
- Amounts have 7 decimal places: send `amount × 10^7`.
- The wallet does not approve or accept anything. The transfer lands as soon
  as your transaction succeeds. It needs no trustline and no XLM to receive,
  and Veil charges nothing to receive. You pay the network fee.
- The address never changes. It is fixed when the wallet is made and cannot be
  moved to another person.
- One person can make more than one wallet. Pay the address they linked, and
  let them link again with `connect()` if they change wallets.
- Receiving does not need the person's passkey. Spending does. A person who
  loses their passkey with no backup set up in Veil still receives the money
  but cannot move it.

## How an app is added

An app is a code change in `frontend/wallet/lib/connect.ts`: an id, the name
shown to people, and the exact web origins (`https://…`) allowed to send
requests. Veil accepts a request only from those origins, and sends the answer
only to the origin that asked. So nobody can ask for a payment in an app's
name from a link in a chat or from another site.

Before adding an app, know who runs it and what it does. The app's users
become Veil users, and their naira moves through Veil's payment provider.

## Testing from your own machine (Stake-Sync)

While you build, use the app id `stakesync-test` from a page on
`http://localhost:3000`. It talks to the live wallet, so payments are real:
use small amounts. People see the name "Stake-Sync (test)". On your live site
use `stakesync`. The test id is removed when the pilot goes live.

## Trying it locally

1. Run the wallet: `cd frontend/wallet && npm run dev` (port 3000).
2. Serve `examples/veil-connect/` on port 5500, for example
   `npx serve -l 5500 examples/veil-connect`.
3. Open `http://localhost:5500`. The `demo` app id works only against a local
   wallet; a production build does not know it.

## Not in the pilot

- Paying without the passkey each time (the wallet contract can limit an app
  to an amount; nothing uses that yet).
- A webhook to the app's server. Verify by hash instead.
- Mobile apps. This is for web apps in a browser.
- Naira straight to USDC in one step.
