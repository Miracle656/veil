# Wave batch — the other half of a data bundle purchase (W126)

Found 2026-10-21 while answering veil #1144. wraith #267 adds the endpoint that
*lists* data bundles. Nothing lets a client *buy* one. Two contributors were
each building a half, and the halves do not meet.

## Shared with every issue

**Repo:** `Miracle656/wraith`. Install with `npm ci`, typecheck with
`npx tsc --noEmit`, test with `npx jest --runInBand` — jest, not vitest.
Regenerate the API spec with `npm run docs:openapi`; it must come out
byte-identical unless you meant to change it.

**This backend carries live money.** The naira rails run against a real
provider.

**`customerId` carries personal data** — a phone number for airtime, a meter
number for electricity. It is passed to Linq and never stored, for the same
reason a NIN never is: it is personal data under Nigeria's NDPA. Do not log it,
do not persist it, and do not put anything resembling a real one in a fixture.

---

### W126 · You can list data bundles but there is nowhere to say which one you bought

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background

`BillCategory` has included `"data"` since the bill rails shipped, and #267 is
adding `GET /ngn/bills/data/bundles?operator=…` so a client can see what is for
sale.

The purchase side was never extended to match. This is the entire payload
`POST /ngn/bills` accepts, from `src/api/ngn.ts` and `src/linq/bills.ts`:

```
customerRef, billCategory, provider, customerId,
amountNgn, amountStableCoin, rate, coin, refundAddress
```

Nine fields, and **not one of them identifies a product.** `customerId` is
documented in `src/linq/bills.ts` as:

```ts
/** Who the bill is for: a phone number for airtime, a meter number for electricity. */
customerId: string;
```

so it is the subscriber, not the purchase.

That is fine for airtime, where the amount *is* the product — ₦500 of airtime
is fully described by `amountNgn`. It does not work for data, where 1 GB for 30
days and 500 MB for 7 days can cost the same and are different things. Sending
only a naira amount asks Linq to guess.

The consequence today: once #267 lands, a client can list bundles, show them,
let the user pick one, and then has no way to tell us which was picked. The
mobile screen in veil #1144 is already built and already hit this — its author
assumed the bundle id travelled in `customerId`, which would overwrite the
phone number.

### What to build

**Find out what Linq calls it first.** This is the part to do before writing
code, and the answer is not in this repo. Check their API documentation for how
a data purchase names the chosen bundle — a product code, a plan id, a variation
code, whatever they use. Our field should carry theirs through, not invent a
parallel vocabulary. Write what you found in the PR, with a link.

Then:

- Add the field to `POST /ngn/bills` **alongside** `customerId`, never instead
  of it. Both are needed: which bundle, and which phone number.
- Treat it as opaque. It is the provider's identifier and we should not parse,
  validate the shape of, or derive meaning from it — only pass it through. The
  listing endpoint in #267 hands it to the client; the client hands it back.
- Require it for `billCategory: "data"` and reject a data purchase without it,
  with a 400 that names the field. Do not silently fall back to an
  amount-only purchase, because that is a payment for something nobody chose.
- Decide what it means for the other categories. Electricity and cable TV may
  have the same shape of problem; airtime does not. Say which in the PR rather
  than leaving it ambiguous.
- Record it on the order, so a later status poll or a support question can say
  what was actually bought. `NgnOrder` already stores `billCategory` and
  `provider`; this belongs next to them.

Coordinate with @ayo-mide55 on #267 — the id your endpoint returns and the id
this route accepts have to be the same string, and the two PRs should agree
before either lands.

### Acceptance criteria

- [ ] The PR states what Linq's own API calls this field, with a reference
- [ ] `POST /ngn/bills` accepts the bundle identifier alongside `customerId`
- [ ] A `data` purchase without it is rejected with a 400 naming the field
- [ ] The identifier is passed through opaquely — not parsed or reinterpreted
- [ ] The chosen bundle is recorded on the order and readable from the status route
- [ ] The behaviour for non-data categories is decided and stated
- [ ] `customerId` still carries only the subscriber, and appears in no log or fixture
- [ ] The id matches what #267's listing endpoint returns, confirmed with its author

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---
