# Wave batch 23 — Veil Names, where the name is the NFT (DRAFT)

**Repo:** `Miracle656/veil`. **IDs:** V267–V275 (batch 22 ends at V266). **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** create the `epic:names` label.

## What this is

Usernames as `jack*useveilapp.xyz`, **5 USDC** each. The first twenty registrations get one of the twenty Masquerade figures in `brand/veil-masquerade/`, name #1 bound to Masquerade #01 straight through.

The decision that shapes every issue here: **the NFT is the name.** Resolution answers by asking who holds token #N *right now*, not by reading a stored row. Transfer the token and the name goes with it. The alternative — a souvenir NFT beside a name pinned to a wallet — leaves the NFT worth nothing and the name stuck, so it was rejected.

No marketplace work. Holders keep or transfer, person to person. That also settles a question nobody needs to answer: the tokens stay **CAP-46**, which `frontend/wallet/lib/nfts.ts` already reads, because the only reason to consider classic Stellar assets was listing on the DEX or Litemint.

## Shared with every issue

### How names work on Stellar, because it is not what people expect

There is **no ENS equivalent** — no dominant on-chain registry to plug into. The standard is **SEP-2 federation**: `name*domain`, resolved by a server the domain owner runs. Small Soroban registries exist (Nameroot) but nothing established enough to build on.

That means Veil owns the `useveilapp.xyz` namespace outright and sets its own rules. This is not a workaround; it is the mechanism.

### What exists today, verified 2026-10-07

| | State |
| --- | --- |
| `frontend/wallet/lib/federation.ts` | **Resolves** `name*domain` already |
| `https://useveilapp.xyz/.well-known/stellar.toml` | **404** |
| `https://app.useveilapp.xyz/.well-known/stellar.toml` | **404** |
| A registry that issues names | does not exist |
| Paying 5 USDC from a Veil wallet | works — USDC from the `C…` address via SAC + `__check_auth`, verified on mainnet |
| The 20 figures and their metadata | `brand/veil-masquerade/`, generated from `traits.json` |

So the read half is built and the write half is not. wraith is the natural home for the server: it already has Postgres and already serves the wallet.

### The one bug that blocks everything

`frontend/wallet/lib/federation.ts` caches resolutions in a plain object with **no expiry**:

```ts
const cache: Record<string, FederationResult> = {}
```

Harmless while a name is permanent. The moment a name can change hands it routes **payments to the previous owner**, because the cached answer never expires and nothing invalidates it. V267 exists to fix that, and it should land before anything that makes a name transferable.

### Ground rules

- **A name resolves to its current holder, never to a stored address.** Any code path that remembers an address for a name is the bug above wearing a different hat.
- **One name per verified person.** The NIN check is the gate (Linq deduplicates NIN, so one NIN is one human); one-per-passkey is a second line, and bounds one-per-*wallet* only.
- Never log or display a NIN, and never store one outside the existing verification path.
- Nothing in this batch lists a token for sale or quotes a resale price.
- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.
- Mobile installs with plain `npm install`, never `--legacy-peer-deps`, and tests with jest via `jest-expo`. wraith's unit tests are jest; integration is vitest; do not mix them in one file.

---

### V267 · A cached name sends money to whoever used to own it

**Labels:** help wanted, Stellar Wave, area:wallet, difficulty:intermediate, epic:names

### Background
`lib/federation.ts` keeps every resolution it has ever made in a module-level object with no TTL and no invalidation. That is a sensible optimisation for a name that cannot move. This batch makes names move, and then the cache is a money bug: a stale entry sends a payment to the address that *used* to hold the name.

### What to build
- Give the cache a short TTL, or remove it. Measure before assuming it is needed; a federation lookup is one HTTP request.
- Whatever replaces it must have no path that returns an entry older than its TTL, including on an error from the server.
- A failed or expired lookup must surface as "could not resolve", never as a previously-good answer.

### Acceptance criteria
- [ ] A resolution older than the TTL is re-fetched, with a test that moves a clock rather than sleeping
- [ ] A name whose holder changed resolves to the new holder on the next lookup
- [ ] A server error does not serve a stale hit
- [ ] The web wallet and mobile behave identically here, or the difference is written down

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V268 · Publish a stellar.toml so the name means something off-platform

**Labels:** help wanted, Stellar Wave, area:website, difficulty:easy, epic:names

### Background
`useveilapp.xyz` serves no `stellar.toml` at all. Without one, `jack*useveilapp.xyz` is a string Veil understands and nothing else does. With one, any Stellar wallet implementing SEP-2 can resolve it.

### What to build
- A `stellar.toml` at `https://useveilapp.xyz/.well-known/stellar.toml`, served with the right content type and CORS, declaring `FEDERATION_SERVER` and the usual `[DOCUMENTATION]` block.
- It is a published artefact: no provider names, no internal URLs, nothing that is not meant to be read by strangers.
- A check that fails if the file stops being served or stops parsing — `scripts/verify-asset-registry.mjs` already fetches and parses TOML and is worth reading first.

### Acceptance criteria
- [ ] The file is reachable over HTTPS and parses as TOML
- [ ] `FEDERATION_SERVER` points at the real endpoint
- [ ] A third-party SEP-2 resolver can follow it end to end, and the PR says which one was tried
- [ ] CI fails if the file disappears or stops parsing

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V269 · The registry: claim a name, pay for it, once

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced, epic:names

### Background
Nothing issues names today. This is the write half.

### What to build
- A names table in wraith and a claim endpoint. A name is claimed by a wallet, bound to one token id, and never reassigned by the server.
- **5 USDC, paid before the name is held.** A claim that is not paid for does not reserve anything — a pending claim that blocks the name is how good names get squatted for free.
- **One claim per passkey.** The passkey public key is the signer on the wallet contract, so "this key already claimed" is checkable and cannot be spoofed; a claim must be signed by it.
- Normalise names on the way in: case, whitespace, and the confusable characters that make `jack` and `jаck` different strings. Decide the allowed character set and write it down.
- Reserve the obvious ones before launch — `veil`, `admin`, `support`, `help` — rather than buying them back later.

### Key files
- wraith: a new router, plus Prisma schema. `prisma db push` ignores committed migrations; use a migration.

### Acceptance criteria
- [ ] A name cannot be claimed twice, under concurrent requests — test it concurrently, not sequentially
- [ ] An unpaid claim reserves nothing
- [ ] A second claim from the same passkey is refused
- [ ] Confusable and differently-cased forms of a taken name are also taken
- [ ] Reserved names cannot be claimed

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V270 · One human, one name

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:intermediate, epic:names

### Background
The twenty figures are meant to end up with twenty different people. Price alone does not do that — somebody can fund twenty wallets. What cannot be faked is a NIN: Linq deduplicates it, so one NIN is one person, permanently, and it is a step users already complete before cashing out.

### What to build
- The claim path requires a verified wallet, and refuses a second claim against a NIN that already has a name.
- The check reads the **existing** verification state. Do not add a second KYC path, do not store a NIN anywhere new, and never put one in a log or a response.
- An unverified user is told what to do next, in words, not given a failure.

### Acceptance criteria
- [ ] A verified wallet can claim exactly one name
- [ ] A second wallet verified against the same NIN is refused, and told why without naming the first wallet
- [ ] No NIN appears in any log, error, or response body — assert it
- [ ] An unverified user gets a next step rather than an error

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V271 · Resolve a name to whoever holds the token right now

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced, epic:names

### Background
This is the decision the batch is built on. The server does not store "jack lives at G…". It stores "jack is token #7" and answers by reading who holds token #7 at the moment of the question. That is what makes the name transferable without a migration step, and it is why V267 has to land first.

### What to build
- `GET /federation?q=<name>*useveilapp.xyz&type=name` returning SEP-2's `{ account_id }`, resolved from the token's current holder.
- `type=id` for the reverse direction, which V272 needs.
- Hold the chain lookup behind a short server-side cache with an explicit TTL, documented in the response headers. The tension here is real: too long and the answer is wrong after a transfer, too short and every payment screen hammers the RPC. Pick a number and justify it in the PR.
- If the holder cannot be read, the endpoint returns an error. It never falls back to a last-known address.

### Acceptance criteria
- [ ] A name resolves to the current holder, and to the new one after a transfer
- [ ] The response shape is SEP-2 compliant and a third-party resolver accepts it
- [ ] An unreadable holder is an error, never a stale address
- [ ] The cache TTL is explicit, tested, and reasoned about in the PR

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V272 · Show the name, not the address

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:names

### Background
A name nobody sees is a name nobody wants. The payoff is the activity feed reading "paid jack" instead of "paid GABC…XYZ".

### What to build
- Reverse resolution wherever an address is rendered: activity, transaction detail, the send screen's recipient field.
- **An unresolved address stays an address.** Never guess, and never show a name the server did not return.
- A name shown must be the one that resolves *now*; a cached label on a transferred name is the V267 bug in the UI.
- Sending to a name resolves it at send time and shows the resolved address before signing, so what is being paid is visible.

### Acceptance criteria
- [ ] Names appear in activity, detail and send, on both clients
- [ ] An address with no name renders exactly as it does today
- [ ] The resolved address is shown before anything is signed
- [ ] Tests cover resolved, unresolved, and a resolver outage

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V273 · Moving a name moves the money that was going to it

**Labels:** help wanted, Stellar Wave, area:wallet, area:mobile, difficulty:intermediate, epic:names

### Background
If the token moves, every future payment to that name follows it. That is the model working as intended, and it is also the thing that has caught ENS users out for years: somebody sells a name and the payments they were expecting go to the buyer.

### What to build
- A transfer confirmation that states plainly what is happening: the name goes with it, and anyone who has saved this name will pay the new holder from now on.
- The warning names the specific name being transferred, not "your name".
- No dark pattern in either direction — do not make transfer hard, make it understood. One confirmation, clear words, no countdown.

### Acceptance criteria
- [ ] Transferring a token that carries a name shows the consequence before it is signed
- [ ] Transferring a token with no name does not show it
- [ ] The copy names the name being moved
- [ ] A test asserts the warning cannot be skipped on a name-carrying token

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V274 · Bind name #N to Masquerade #N, and write it into the metadata

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:intermediate, epic:names

### Background
The first twenty names get the twenty figures in `brand/veil-masquerade/`, in order: name #1 to Masquerade #01. The numbering is the point — the token is the proof of being early, and that is the whole reason the collection is twenty rather than any other number.

### What to build
- Claim order decides the figure, and the binding is permanent.
- The `Name` trait goes into the token's metadata at claim time. `scripts/build-nft-metadata.mjs` already generates these files from `traits.json`; extend it rather than hand-editing any `metadata/NN.json` — the `--check` mode exists to catch exactly that.
- The twenty-first claimant gets a name and no figure, and is told so before paying.
- `#09 is the only closed mask in the set.` Whether that is special-cased or simply goes to the ninth claimant is a product decision — make it deliberately and write down which.

### Acceptance criteria
- [ ] Claim order maps to figure number, and cannot be reassigned afterwards
- [ ] `build-nft-metadata.mjs --check` passes with the `Name` trait present
- [ ] Rarity counts still come from counting, not from assertion
- [ ] The twenty-first claimant is told there is no figure before they pay

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V275 · The claim screen

**Labels:** help wanted, Stellar Wave, area:mobile, area:wallet, difficulty:intermediate, epic:names

### Background
Everything above is invisible without somewhere to type a name.

### What to build
- Check availability as the user types, with the normalisation from V269 applied so a name that looks free is free.
- State the price before the keyboard appears, and show the figure they would receive if they are in the first twenty.
- Pay 5 USDC in USDC from the wallet's `C…` address — the existing SAC + `__check_auth` path, not a new one.
- A failed payment leaves no half-claimed name. A successful payment that fails to bind must be recoverable without charging twice.
- An unverified user is routed to verification and back, keeping the name they typed.

### Acceptance criteria
- [ ] Availability reflects the server's normalisation, not the client's guess
- [ ] Price and figure are shown before payment
- [ ] A failed payment claims nothing; a double-tap charges once
- [ ] An unverified user can verify and return without retyping
- [ ] The screen works at phone width on both clients

> **Drips Wave** · Complexity: **Intermediate** · **150 points**
