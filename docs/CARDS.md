# Cards — Bridgecard assessment

**Status:** research only, nothing built · **Assessed:** 2026-09-22 · **Source:** Bridgecard's own
developer docs (`docs.bridgecard.co`, read via its `llms.txt` index), their site and YC profile.

A card is the most-requested neobank feature (see `docs/PRODUCT_VISION.md`): spend USDC anywhere
Mastercard is accepted — Netflix, Meta ads, Apple, online shopping. This records what Bridgecard
offers, how it would fit Veil, and what has to be true before building it.

> **Do not confuse Bridgecard with Bridge.** Bridgecard (bridgecard.cards, YC S22, Lagos) is an
> African card issuer. **Bridge** (bridge.xyz) is Stripe's stablecoin company, which also issues
> cards. Search results conflate them; they are different companies with different models.

## What Bridgecard is

A card-issuing API for African businesses. The business registers its users as cardholders, and
Bridgecard issues them Mastercard cards.

| Card | Type | Currency | Limit |
|---|---|---|---|
| Mastercard | Physical | Multicurrency (NGN and USD) | $1,500 a month and ₦1,000,000 a day |
| Mastercard | Virtual | Multicurrency (NGN and USD) | $1,500 a month and ₦1,000,000 a day |
| Mastercard | Virtual | USD | $5,000 or $10,000 a month |

- **Countries:** Nigeria, Ghana, Kenya, Angola, Uganda and a "rest of the world" profile.
- **Sandbox:** yes — production and sandbox tokens from their dashboard.
- **Card details:** the PAN is returned encrypted and decrypted through an Evervault relay, so the
  app can show a card without handling raw numbers. Their docs say not to store card details
  unless PCI-DSS compliant.
- **Pricing:** not published. Ask.

## How money moves — the part that matters

Bridgecard runs on an **issuing wallet**: a float the *business* pre-funds, from which each card is
loaded by API. Their docs document no stablecoin funding, so for Veil the flow would be:

1. The user moves USDC out of their self-custodied Veil wallet.
2. **Veil** converts it to USD and holds it in Veil's issuing wallet at Bridgecard.
3. Veil loads the user's card from that float.

**That makes Veil custodian of user money in transit, and the card program's manager** — Veil
collects every cardholder's KYC and sends it on. Today Veil holds no user funds and no identity
data: funds sit in the user's own passkey wallet. A card through Bridgecard would change both.

KYC per Nigerian cardholder: BVN with a selfie, or NIN / driver's licence with ID images, BVN and a
selfie. Synchronous verification can take up to 45 seconds; asynchronous verification is about two
minutes, reported by webhook.

## Why not yet

1. **Legal first.** `docs/NGN_RAILS.md` downgraded "we're just the tech layer" to *not safe* under
   the ISA 2025 "arranging" provisions. Holding a USD float for users and running a card program is
   further into regulated territory than the offramp, not less. This needs the same SEC/CBN answer
   first.
2. **It breaks the self-custody model** that is Veil's pitch and its SCF story, and it adds
   personal-data obligations (Nigeria Data Protection Act) that Veil does not carry today.
3. **SCF comes first.** Budget-wise, card issuance is not Stellar-integrated development, so it is
   not something the award would fund.

## The alternative worth comparing

Stablecoin-native issuers debit the user's wallet at the moment of the swipe, rather than a
business float. Bridge (Stripe) advertises cards that spend "directly from custodial wallets,
noncustodial wallets", with Visa, live in 18 countries and planned for 100+ — Africa included — by
the end of 2026. Rain is another. That model fits a self-custodied wallet far better: no Veil float,
and less of Veil in the flow of funds. **Unverified for us:** whether either supports Stellar USDC,
and whether either covers Nigerian cardholders yet.

## If we pursue it — questions to ask

Ask Bridgecard:
- Can the issuing wallet be funded in USDC, and on Stellar? At what conversion cost?
- Who is the BIN sponsor / principal Mastercard member, and under which licence do you issue to
  Nigerian residents?
- What is the program manager (Veil) responsible for — KYC liability, disputes, chargebacks, fraud?
- Pricing: card creation, monthly, funding, FX, and decline fees.

Ask Bridge and Rain:
- Do you support Stellar USDC, and non-custodial wallets on Stellar specifically?
- Are Nigerian residents eligible cardholders today, or when?

## Sources

- Bridgecard developer docs: https://docs.bridgecard.co (index: https://docs.bridgecard.co/llms.txt)
- Bridgecard on Y Combinator: https://www.ycombinator.com/companies/bridgecard
- Bridge + Visa stablecoin cards: https://stripe.com/newsroom/news/bridge-partners-with-visa
- Visa and Bridge expansion (2026): https://investor.visa.com/news/news-details/2026/Visa-and-Bridge-Expand-Collaboration-with-Plans-to-Bring-Stablecoin-Linked-Cards-to-Over-100-Countries/default.aspx
