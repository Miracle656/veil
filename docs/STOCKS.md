# Tokenised stocks — why they are not shipped

_Checked on-chain 2026-10-04. Design: `Veil Stocks.dc.html` in the design project._

## The short version

The stock tokens in the design **exist on Stellar, and every one of them is
fake.** We cannot list them, not even read-only, because doing so would point
users at a forgery on the screen that tells them what to buy.

## What the design asks for

A full flow — eligibility gate, discover, stock detail, buy (market and
after-hours), review, success, portfolio, sell — with tokens named `AAPLon`,
`NVDAon`, `TSLAon`, paid for from the USDC balance at a 0.10% fee. The issuer is
named as **Ondo Global Markets**; the `…on` suffix is their naming.

## What is actually on Stellar

`AAPLon` is issued by **four** different accounts on mainnet. Not one of them
resolves to a domain Ondo controls:

| Issuer home domain | Accounts | Verdict |
| --- | --- | --- |
| `onxlm.com` | 13 | not Ondo |
| `xlmstellar.online` | 3 | not Ondo |
| `ondo.dtcc.markets` | 5 | **built to look official; is not** |
| `xchaincoin.org` | 5 | not Ondo |

**The real `ondo.finance` stellar.toml declares exactly one currency: `USDY`.**
No stocks. Ondo Global Markets has not issued on Stellar.

### `ondo.dtcc.markets` is the dangerous one

It is not a lazy squatter. Under its own issuer
(`GDAEH2FUWBXF63N3M5YHMZCIGENAPIPWDBKA3XUOP5LUDT5MI3B6XBEX`) it publishes:

- a **counterfeit `USDY`** — an asset Veil genuinely lists
- fake `ONDO` and `OUSG`
- the stock tokens

and it copies Ondo's own asset descriptions close to verbatim. The domain is
assembled from two trusted names (Ondo, DTCC) to survive a glance.

## Why Veil is not exposed to it today

The asset registry pins `USDY` to the real issuer
(`GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6`) and contains none
of the impersonators, and `isRegisteredIssuer` is what every display path checks.

This is the rule from the NGN research — **never match an asset on its code
alone** — holding in a place nobody was watching. It is worth keeping that rule
load-bearing rather than convenient.

## What shipped instead

Explore carries a **Stocks** card marked `SOON` that lists no assets. It makes
the design's promise without naming anything that could be bought.

## What would unblock it

Not an integration. A **conversation with Ondo** about issuing on Stellar, or a
different issuer that verifies. The sequence afterwards is:

1. Confirm the issuing account from the issuer's own `stellar.toml`.
2. Add entries to `ASSET_REGISTRY` in **both** wallet and mobile, `kind: 'equity'`
   — the kind already exists and nothing uses it yet.
3. Expect SEP-8 regulated-asset handling: `docs/pages/invest.mdx` already notes
   that whitelisted assets have the issuer run its own KYC directly, never
   through Veil.
4. Only then build the buy flow, which is where the design's real weight is.

Read-only first is **not** a shortcut here. Displaying a price for an asset
nobody can verify is the part that causes harm; buying is merely the part that
costs money.
