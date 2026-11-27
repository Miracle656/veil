# Veil Connect (pilot)

Lets another web app use a person's Veil wallet without that person installing
anything. The app opens a Veil window; the person creates or unlocks their
wallet there with a passkey; the app gets an answer back.

Status: **pilot**. One partner, small amounts, the interface may change.

Veil is a product of Divinity Labs Limited, a company registered in Nigeria
(RC 10031131).

## What it does

| Call | The person sees | The app gets |
|---|---|---|
| `connect()` | "Share your wallet address with App?" | `{ address, network }` |
| `pay({...})` | Who is asking, how much, to which address, then Veil's normal Send screen | `{ hash, reference, network, from, memo }` |
| `invoke({...})` | Which of your contracts, which function, the values, and any money it takes from them | `{ hash, network, contract, method, signer, from, result }` |
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

## Calling your own contract

`invoke()` asks the person to approve one call to one of your contracts, with
their passkey. Use it for anything that is more than a plain payment: joining
a challenge, staking, claiming a reward.

```js
const { address } = await veil.connect()

const { hash, result } = await veil.invoke({
  contract: 'C…',                 // your contract, registered for your app id
  method: 'join_challenge',
  args: [
    { type: 'address', value: address },
    { type: 'u32', value: 7 },
    { type: 'i128', value: '50000000' },   // 5 USDC: amounts have 7 decimals
  ],
})
```

You pass a contract, a function name and typed values. Veil builds the
transaction. Veil does not sign a transaction an app hands it.

**Argument types:** `address`, `bool`, `u32`, `i32`, `u64`, `i64`, `u128`,
`i128`, `string`, `symbol`, `bytes` (hex). Pass large numbers as strings. At
most 12 arguments. Lists, maps and structs are not carried yet: if your
function needs one, tell us.

**Whose approval your contract should ask for.** Use the address from
`connect()`. It is the person's wallet, a `C…` contract address, and
`address.require_auth()` on it is answered by their passkey. To take a token
from them inside your function, call the token's
`transfer(from = their address, to = …, amount)`; the person approves that
together with your function, in one prompt.

**What the person sees before approving:** your app's name, the contract and
function, every value, every token amount leaving their wallet and where it
goes, and the network fee. They can open the full list of calls being
approved.

**What Veil refuses, whatever the contract does:**

- a contract that is not registered for your app id on that network;
- `approve` on any token (a standing allowance);
- any call into the person's own wallet contract;
- deploying a contract;
- more than 1,000 XLM or 1,000 USDC leaving in one request;
- a call that needs approval from an address that is not the person's.

If what the call would do changes between the screen the person read and the
moment they approve, nothing is signed and they are told to start again.

**Fees.** The network fee is paid in XLM by the person's spending account
(the `G…` address in `from`). A person with no XLM there is told to add some.
Veil adds no fee of its own to a contract call.

**The result.** `signer` is the wallet that approved (the `connect()`
address). `from` is the account that carried the transaction. `result` is
what your function returned, as base64 XDR of an `ScVal`, or `null`. Like a
payment, it is a claim from the browser: look the `hash` up on the network
before your server acts on it, check it succeeded and called your contract
and function, and accept each hash once.

**Registering a contract.** Send us the contract id for each network and its
source. We read it before adding it, because your users will be asked to
approve what it does.

## How an app is added

An app is a code change in `frontend/wallet/lib/connect.ts`: an id, the name
shown to people, and the exact web origins (`https://…`) allowed to send
requests. Veil accepts a request only from those origins, and sends the answer
only to the origin that asked. So nobody can ask for a payment in an app's
name from a link in a chat or from another site.

An app that calls contracts also lists them there, per network, each written
in full. `invoke()` is refused for any contract not on the app's list.

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
- Signing a ready-made transaction, or a contract call whose arguments are
  lists, maps or structs.
- More than one contract call in a single approval.
- Naira straight to USDC in one step.
