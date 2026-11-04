# Wave batch — Lens keys, admins & accountability (L231–L250)

Drafted 2026-10-18 by reading `Divinity-Labs/Lens` at `main`. Checked against
all 146 open issues first — one mentions auth and nothing here duplicates it.

The theme: Lens authenticates REST with bearer API keys, meters them through
x402, and mints them from an admin surface guarded by one shared secret. The
key machinery itself is sound — 192 bits of entropy, only hashes stored,
quotas genuinely enforced. What is missing is everything around it: keys that
never expire, no record of who minted or revoked one, a security check
copy-pasted into two files, a database round-trip on every single request, and
a websocket that asks for nothing at all.

## Shared with every issue

**Repo:** `Divinity-Labs/Lens`. Auth is `src/api/auth.ts`, key minting
`src/api/admin.ts`, usage reporting `src/api/usage.ts`, metering
`src/x402/metering.ts`, the `ApiKey` model in `prisma/schema.prisma`.

**Run the tests:** `npm test`. **The tests are vitest, not jest.** A single file
is `npx vitest run src/__tests__/auth.test.ts`.

**`Load test (prices)` is already failing on `main`.** Not your PR.

**Do not weaken what is already right.** Three things are correct today and
should survive every change here:

- `generateApiKey()` is `lens_` plus `randomBytes(24)` — 192 bits. Do not
  shorten it, and do not make it guessable or sequential.
- `hashApiKey()` is an unsalted SHA-256. That is **correct** for a
  high-entropy random key: it must stay fast and deterministic so a lookup is
  one indexed query. Do not "improve" it into bcrypt or argon2 — those are for
  low-entropy human passwords, and here they would only make every request slow.
- Only the hash is ever stored. The plaintext is returned once, at creation,
  and never again.

**Admin routes carry `config: { public: true }`.** That does not mean public —
it means "skip the API-key hook", because they enforce `ADMIN_TOKEN` instead.
Removing that flag locks the admin surface behind the keys it exists to mint.

**Never elide an address, a key or a token** in code, comments, tests or
documentation. Write it in full or not at all — and never write a *real* key
anywhere.

---

### L231 · Every authenticated request costs a database round-trip

**Labels:** help wanted, Stellar Wave, area:performance, difficulty:intermediate

### Background

`src/api/auth.ts` authenticates like this, on every request:

```ts
export async function lookupApiKey(plaintext: string): Promise<ApiKeyContext | null> {
  const hash = hashApiKey(plaintext)
  const record = await prisma.apiKey.findUnique({ where: { hash } })
  if (!record || record.revokedAt) return null
  ...
}
```

It runs in an `onRequest` hook, so a request cannot even begin until Postgres
answers. Two consequences:

- **Latency floor.** Every single request pays a database round-trip before any
  work starts, including requests that would otherwise be served entirely from
  the Redis price cache.
- **Availability.** The connection pool is shared with the ingesters and the
  retention worker. When Postgres is slow or the pool is exhausted, the API does
  not degrade — it stops, because nothing can authenticate.

### What to build

- Cache the lookup, keyed by the hash, with a short TTL.
- **Revocation must stay effectively immediate.** That is the hard part and the
  reason this is not a one-line change: a revoked key sitting in a cache is a
  key that still works. Keep the TTL short, invalidate on revoke, or both — and
  say in a comment what the worst-case window is.
- Cache negative lookups too, or an invalid key becomes a free way to make the
  API hit Postgres as fast as the client can send requests.
- A metric for cache hit rate, so this is observable rather than assumed.

### Acceptance criteria

- [ ] A repeated request with the same key does not query Postgres every time
- [ ] Revoking a key stops it working within a documented, short window
- [ ] Invalid keys do not cause a database query per attempt
- [ ] Cache hit rate is exported as a metric
- [ ] A test proves a revoked key stops working

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L232 · The admin check is copy-pasted into two files

**Labels:** help wanted, Stellar Wave, area:security, difficulty:easy

### Background

`isAdminAuthorized` exists twice, verbatim, in `src/api/admin.ts` and
`src/api/usage.ts`. Same logic, same comment, one difference:

```ts
// src/api/usage.ts
return a.length === b.length && require('crypto').timingSafeEqual(a, b)
```

`usage.ts` reaches for `require('crypto')` inline, inside the security check,
in a module that imports everything else with ESM syntax.

Two copies of an authorisation check is a liability with a specific failure
mode: someone fixes one. Every improvement in this batch — admin identity
(L233), audit (L234), rate limiting the admin surface — has to be made twice,
and the day it is made once, half the admin routes keep the old behaviour and
nothing fails.

### What to build

- One implementation, in one module, imported by both.
- Import `timingSafeEqual` at the top of the file like every other import.
- Keep the constant-time comparison. Note that the `a.length === b.length`
  guard is required — `timingSafeEqual` throws on mismatched lengths — and is
  not itself a leak worth worrying about for a token of this kind.
- A test that both `/admin/keys` and `/admin/usage` reject a wrong token, so
  the two surfaces cannot drift apart again.

### Acceptance criteria

- [ ] `isAdminAuthorized` is defined once
- [ ] Both admin route files use it
- [ ] No `require()` remains inside a request path
- [ ] Constant-time comparison is preserved
- [ ] A test covers rejection on every admin route

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L233 · No admin action has an author

**Labels:** help wanted, Stellar Wave, area:security, difficulty:advanced

### Background

The entire admin surface is guarded by one shared secret:

```ts
const adminToken = process.env.ADMIN_TOKEN
```

Everyone who can mint an API key holds the same string. So there is no way to
answer "who minted this key", no way to revoke one person's access without
rotating the secret for everyone, and no way to tell an operator apart from
whoever else has seen the value.

The token is also in the environment of every running instance, which means it
is visible to anything that can read the process environment or a crash dump.

### What to build

This needs a decision before code, so propose one in the PR:

- **Multiple named admin credentials** — a set of tokens each with an
  identifier, so an action can be attributed and one can be revoked alone.
- **Or signed requests**, where an admin holds a key pair and the server keeps
  only public keys, so the secret never sits in the server's environment at all.

Whichever you choose:

- An authenticated admin request must carry an identity the server can name,
  and that identity is what L234 records.
- Rotating or removing one admin must not invalidate the others.
- A single `ADMIN_TOKEN` should keep working during migration, with a clear
  deprecation path — do not lock the operator out of their own deployment.

### Acceptance criteria

- [ ] An admin request resolves to a named identity
- [ ] One admin's access can be removed without affecting others
- [ ] Existing `ADMIN_TOKEN` configuration continues to work during migration
- [ ] The migration path is documented
- [ ] No admin secret is logged, echoed or returned

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L234 · Nothing records that a key was minted or revoked

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

`POST /admin/keys` creates a row. `DELETE /admin/keys/:id` sets `revokedAt`.
Neither writes any record of the action itself — no actor, no time, no reason,
no source address. The `ApiKey` row carries `createdAt` and `revokedAt`, and
that is the entire history available.

So: a key exists that nobody remembers creating, and there is no way to find
out when it was created against which request, by whom, or why a key was
revoked. For a surface that mints credentials to a paid API, that is the first
thing an incident review asks for and the one thing that will not exist.

### What to build

- An append-only audit record for every admin action: what was done, to which
  key id, when, by which identity (L233 — design for it being absent until
  then), and from which address.
- Record **attempts**, including rejected ones. A string of failed admin
  authentications is the signal worth having.
- Never record the admin token, the plaintext key, or the key hash.
- A way to read recent entries, admin-guarded like the rest.
- Decide retention deliberately and say what it is.

### Acceptance criteria

- [ ] Key creation and revocation are both recorded
- [ ] Failed admin authentications are recorded
- [ ] Records carry time, action, target and source
- [ ] No secret or plaintext key appears in a record
- [ ] Entries are readable through an admin-guarded route

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L235 · API keys never expire

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

The `ApiKey` model is:

```prisma
model ApiKey {
  id               String    @id @default(uuid())
  hash             String    @unique
  label            String
  ratePerMin       Int       @default(60)
  ratePerDay       Int       @default(10000)
  revokedAt        DateTime? @map("revoked_at")
  createdAt        DateTime  @default(now())
  ...
}
```

There is no `expiresAt`. A key works forever unless somebody remembers to
revoke it, and `lookupApiKey` only ever checks `revokedAt`. A key pasted into a
notebook three years ago is still a valid credential today.

### What to build

- An optional `expiresAt` on the model, set at creation and enforced in
  `lookupApiKey` alongside the `revokedAt` check.
- An expired key must be rejected the same way a revoked one is, and the
  rejection should say which — "expired" is actionable, "invalid" is not.
- Decide whether new keys get a default lifetime. A default that expires is
  safer; a default that does not is friendlier. Pick one, say why, and make it
  configurable.
- Existing keys must keep working: a null `expiresAt` means no expiry.

### Acceptance criteria

- [ ] `expiresAt` exists, is optional, and is enforced on lookup
- [ ] An expired key is rejected with a distinguishable reason
- [ ] Existing keys with no expiry are unaffected
- [ ] The default lifetime is a documented, configurable decision
- [ ] Tests cover an expired key, a null expiry, and a future expiry

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L236 · Nothing records when a key was last used

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:intermediate

### Background

There is no `lastUsedAt` on `ApiKey` and nothing writes one. So nobody can
answer the two questions that come up whenever a key list is reviewed: which of
these is still in use, and which can safely be revoked?

Without it, keys accumulate. Nobody revokes one they are not sure about, which
is the correct instinct and exactly why the information has to exist.

### What to build

- A `lastUsedAt` on the model, updated on successful authentication.
- **Do not write it on every request.** That turns a read-only auth path into a
  write on every call, which is worse than the problem — throttle it, update at
  most once per interval per key, and batch where you can. This interacts
  directly with L231's cache, so read that first.
- Expose it on the key listing (L244) so it is actually usable.

### Acceptance criteria

- [ ] `lastUsedAt` is recorded on successful authentication
- [ ] The write is throttled, not once per request
- [ ] The throttle interval is documented and configurable
- [ ] It is visible wherever keys are listed
- [ ] A test proves repeated requests do not cause a write each time

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L237 · There is no way to rotate a key

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

A caller who suspects their key has leaked has exactly two options: keep using
it, or have it revoked and suffer an outage until a new one is minted,
delivered and deployed.

That gap is why keys do not get rotated. Rotation has to be possible without
downtime or it does not happen, and a key that is never rotated is a key that
is only ever as safe as the day it was issued.

### What to build

- A rotation endpoint that issues a replacement while the old key keeps working
  for a bounded overlap.
- The overlap must be explicit and visible — when it ends, and that it is
  happening at all.
- The old key's identity, quotas and usage history should carry across, so
  rotation does not reset a caller's metering or look like a new customer.
- Rotation is an admin action and belongs in the audit record (L234).

### Acceptance criteria

- [ ] A key can be replaced without an outage
- [ ] The overlap window is bounded, configurable and visible
- [ ] The old key stops working when the window ends
- [ ] Quotas and usage history survive rotation
- [ ] Tests cover both keys working during overlap, and the old one failing after

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L238 · The websocket asks for nothing

**Labels:** help wanted, Stellar Wave, area:security, difficulty:advanced

### Background

Every REST route requires `Authorization: Bearer <key>` unless it opts out with
`config.public`. `src/api/websocket.ts` contains no reference to `apiKey`,
`authorization` or `lookupApiKey` — there is no authentication on the websocket
at all.

So the live price feed, which is the most valuable thing the service produces
and the most expensive to serve, is the one surface that asks for nothing. A
caller who would otherwise pay per request can take a continuous stream for
free, and it is not even a workaround — it is the documented way to connect.

It also means websocket traffic is invisible to metering: no key, no quota, no
usage record, nothing to attribute load to.

### What to build

- Authenticate the connection. For a websocket the credential goes in the
  handshake — a subprotocol value or the first message — not a query parameter,
  because URLs end up in logs and proxies.
- Reject unauthenticated connections at handshake, before any subscription.
- Attach the key context to the connection so per-key limits and metering can
  read it, and so L243's revocation can find it.
- Count connections per key and cap them.
- Coordinate with **#363**, which asks the same of GraphQL subscriptions — one
  mechanism should serve both.

### Acceptance criteria

- [ ] An unauthenticated websocket connection is refused at handshake
- [ ] The credential is not passed in the URL
- [ ] The key context is available for the life of the connection
- [ ] Concurrent connections per key are capped and configurable
- [ ] Tests cover a valid connection, a missing credential and a revoked key

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L239 · Revoking a key does not disconnect anything

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

Revocation sets `revokedAt`, and `lookupApiKey` refuses the key on the **next
request**. A long-lived connection never makes another request — a websocket
subscription authenticated once (after L238) keeps streaming, and so does a
GraphQL subscription.

So revoking a leaked key stops new requests and does nothing about the stream
already running, which is the one that matters: it is continuous, it is the
most valuable data, and it will keep flowing until the client chooses to
disconnect.

### What to build

- On revocation, close live connections belonging to that key.
- Connections must be findable by key — which is what L238's key context on the
  connection is for; build on it rather than inventing a second registry.
- Close with a code and reason the client can distinguish from a restart, so
  reconnect logic does not simply retry forever.
- Multiple instances: a key revoked on one instance must drop connections held
  by another. Redis pub/sub is already in the stack for exactly this shape.

### Acceptance criteria

- [ ] Revoking a key closes its live connections
- [ ] The close carries a distinguishable code and reason
- [ ] Revocation propagates across instances
- [ ] Other keys' connections are unaffected
- [ ] A test proves a subscription stops after revocation

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L240 · Every key can call every route

**Labels:** help wanted, Stellar Wave, area:security, difficulty:advanced

### Background

`ApiKeyContext` carries `id`, `label`, `ratePerMin` and `ratePerDay`. There is
no notion of what a key is *allowed* to do, so every key can reach every
non-public route.

Quotas limit how much, never what. A key issued to a partner who needs spot
prices can also read the screener, the order book, the oracle comparison and
every historical window — and if an admin route is ever moved behind key auth
rather than `ADMIN_TOKEN`, it would reach that too.

### What to build

- Scopes on a key: a set of capabilities, checked per route.
- Keep them coarse. `read:prices`, `read:history`, `subscribe` is a useful
  vocabulary; one scope per endpoint is a maintenance burden that nobody keeps
  current.
- **Existing keys must keep working.** A key with no scopes recorded means
  "everything", or every current integration breaks on deploy.
- Scopes are set at mint time and visible when listing keys.
- A refusal should say which scope was required.

### Acceptance criteria

- [ ] A key can be minted with a scope set
- [ ] Routes declare the scope they require
- [ ] A key without the scope is refused, and the error names it
- [ ] A key with no scopes recorded keeps working as before
- [ ] Tests cover an allowed call, a refused call and a legacy unscoped key

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L241 · There is no way to see what keys exist

**Labels:** help wanted, Stellar Wave, area:dx, difficulty:easy

### Background

The admin surface can mint a key and revoke one by id. It cannot list them. So
to revoke a key you must already know its id, and the id is only ever returned
once — in the response to the request that created it.

In practice that means the only record of which keys exist is whatever the
operator pasted somewhere at creation time. Keys with no known id cannot be
revoked through the API at all.

### What to build

- `GET /admin/keys`, admin-guarded, returning every key's id, label, quotas,
  creation time, revocation state and — once L235 and L236 land — expiry and
  last use.
- **Never return the hash or anything derived from it.** The id and label are
  how a key is identified here.
- Pagination, and a filter for revoked keys. A deployment accumulates these.
- Make the default view hide revoked keys, since the common question is "what
  is live right now".

### Acceptance criteria

- [ ] Keys can be listed through an admin-guarded route
- [ ] No hash or plaintext appears in the response
- [ ] Revoked keys are excluded by default and retrievable on request
- [ ] The listing is paginated
- [ ] A test asserts the hash is absent from the response body

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L242 · Key quotas are stored exactly as sent

**Labels:** help wanted, Stellar Wave, area:api-quality, difficulty:easy

### Background

`POST /admin/keys` validates `label` and nothing else:

```ts
if (!label || typeof label !== 'string' || label.trim().length === 0) {
  return reply.status(400).send({ error: 'label is required' })
}
...
...(ratePerMin !== undefined ? { ratePerMin } : {}),
...(ratePerDay !== undefined ? { ratePerDay } : {}),
```

`ratePerMin`, `ratePerDay`, `monthlyQuotaCents` and `dailyQuotaCents` go
straight to the database. A negative rate, a fractional one, a zero, or a
number large enough to mean "no limit" are all accepted silently, and the
mistake only shows up later as a key that cannot call anything or one that is
never limited.

`overagePolicy` is typed as a union in TypeScript but that type is gone at
runtime, so any string is stored and `src/x402/metering.ts` falls back to
`'block'` for anything it does not recognise — a typo becomes a silent policy
change.

### What to build

- Validate the body with zod, as the routes do elsewhere in this repo, and
  reject rather than coerce.
- Positive integers for rates and quotas, with sane upper bounds.
- `overagePolicy` restricted to the three known values, rejected otherwise.
- Make `ratePerDay` at least `ratePerMin` — a per-day limit below the per-minute
  one is always a mistake.
- Error messages should name the field, as `src/validation.ts` does.

### Acceptance criteria

- [ ] Every numeric field is validated as a positive integer within bounds
- [ ] `overagePolicy` outside the known set is rejected, not silently defaulted
- [ ] Contradictory rate combinations are rejected
- [ ] Errors name the offending field
- [ ] Tests cover a negative, a fractional, an out-of-range and an unknown policy

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L243 · Nothing counts authentication failures

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:easy

### Background

`src/metrics.ts` has no auth metrics. A request with a missing key and one with
an invalid key both return 401 and leave no trace beyond an HTTP status in the
aggregate counter.

So a key that has quietly stopped working after a deploy, and someone walking
the keyspace, look exactly alike from the dashboard: slightly more 401s.

### What to build

- A counter of authentication outcomes labelled by reason — missing, malformed,
  unknown, revoked, and expired once L235 lands.
- A counter of admin authentication failures, which is the sharper signal:
  there is one admin token, so repeated failures mean something.
- **Bounded labels only** — never the key, the hash, a prefix of either, or the
  caller's address.
- Make the reasons the same vocabulary the 401 body uses, so a log line and a
  metric describe the same event.

### Acceptance criteria

- [ ] Auth failures are counted by a bounded reason label
- [ ] Admin auth failures are counted separately
- [ ] No key material or address appears in any label
- [ ] Reasons match what the response body says
- [ ] Metrics appear at `/metrics`

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L244 · An unset ADMIN_TOKEN disables the admin surface silently

**Labels:** help wanted, Stellar Wave, area:config, difficulty:easy

### Background

```ts
function isAdminAuthorized(req: FastifyRequest): boolean {
  const adminToken = process.env.ADMIN_TOKEN
  if (!adminToken) return false
  ...
```

Failing closed is right — an unset token must never mean "allow everyone". But
it fails closed *silently*: the service starts normally, and every admin route
returns the same 401 as a wrong token. An operator who forgot the variable, or
typoed its name, sees "Provide a valid X-Admin-Token header" and goes looking
for a problem with their token.

### What to build

- Log clearly at startup when `ADMIN_TOKEN` is not configured, saying the admin
  surface is disabled.
- Distinguish the two cases in the response: a wrong token is not the same as a
  server with no token configured. Say "not configured" without revealing
  anything about the expected value.
- Surface it on `/status` or `/ready` so it is visible without reading logs.
- Document the variable in `.env.example` with what it gates. The repo's drift
  guard covers `src/`, so check it is there.
- Consider rejecting a trivially weak token at startup — an empty string after
  trimming, or an obvious placeholder.

### Acceptance criteria

- [ ] Startup logs that admin routes are disabled when the token is unset
- [ ] "Not configured" and "wrong token" are distinguishable to an operator
- [ ] Neither response reveals anything about the expected value
- [ ] `.env.example` documents the variable and what it gates
- [ ] A test covers the unset case

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L245 · Rate limiting is per key, with no global ceiling

**Labels:** help wanted, Stellar Wave, area:reliability, difficulty:intermediate

### Background

`src/app.ts` configures per-key limits from `ratePerMin`, and `/status` is
allow-listed. There is no limit on the service as a whole.

So the protection scales with the number of keys: fifty keys at sixty requests
a minute is three thousand requests a minute, all legitimate, all within
quota, and nothing anywhere decides whether this deployment can serve that. The
first sign is the connection pool (#339) exhausting and every route slowing
down together.

Per-key limits answer "is this caller being unfair". They do not answer "can we
serve this".

### What to build

- A global request ceiling, configurable, applied after per-key limits.
- When it trips, shed load in a defined order — the expensive routes before the
  cheap ones, and never `/status`, `/live` or `/ready`, since dropping health
  checks under load gets the instance killed exactly when it is working.
- A distinct response and metric for global shedding versus per-key limiting.
  Telling a caller inside their quota that they exceeded it is a lie that costs
  support time.
- Document how the ceiling relates to instance count.

### Acceptance criteria

- [ ] A global ceiling exists and is configurable
- [ ] Health endpoints are never shed
- [ ] Global shedding is distinguishable from per-key limiting in both response and metrics
- [ ] Per-key limits still apply beneath it
- [ ] A test proves a caller within quota is told the truth about why they were refused

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L246 · The admin surface has no tests

**Labels:** help wanted, Stellar Wave, area:testing, difficulty:intermediate

### Background

`src/__tests__/` has `auth.test.ts` and `usage.test.ts`. There is no
`admin.test.ts`, so the route that **mints credentials** for a paid API is
untested: not that it rejects a wrong token, not that it stores only a hash,
not that the plaintext is returned exactly once.

L232 is the reason this matters. The admin check exists in two copies, and
there is no test that would notice if one of them stopped checking.

### What to build

- Tests for `POST /admin/keys` and `DELETE /admin/keys/:id`: rejected without a
  token, rejected with a wrong token, accepted with the right one.
- Assert **the stored row contains no plaintext** and that the hash is the
  SHA-256 of the returned key — the central security property of this design.
- Assert the plaintext is returned on creation and never by any other route.
- Assert a revoked key stops authenticating.
- Use a generated throwaway token; never commit a real one.

### Acceptance criteria

- [ ] Both admin routes are tested for all three authorisation outcomes
- [ ] A test asserts no plaintext key is stored
- [ ] A test asserts the stored hash matches the returned key
- [ ] A test asserts revocation takes effect
- [ ] No real token or key appears in the test fixtures

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L247 · A 401 says the same thing for four different problems

**Labels:** help wanted, Stellar Wave, area:api-quality, difficulty:easy

### Background

```ts
return reply.status(401).send({
  error: 'Unauthorized',
  message: 'Invalid or revoked API key.',
})
```

Invalid and revoked are different problems with different fixes — one is "check
what you pasted", the other is "ask for a new key" — and after L235 expired
joins them. The caller is told to work out which.

There is also no machine-readable code, so a client that wants to distinguish
them has to match on prose, which this repo has already decided against
elsewhere (`src/validation.ts`, and `LinqError.code` in the sibling service).

### What to build

- A `code` on every 401: missing, malformed, unknown, revoked, expired.
- Keep the human message useful and keep both aligned.
- **Say nothing a valid key would not reveal.** "Revoked" is safe to tell
  someone holding the key. Whether an *unknown* key ever existed is not, so
  unknown and never-existed must look identical.
- Document the codes alongside the authentication documentation.

### Acceptance criteria

- [ ] 401 responses carry a machine-readable code
- [ ] Revoked and expired are distinguishable from unknown
- [ ] An unknown key reveals nothing about whether it ever existed
- [ ] The codes are documented
- [ ] Tests cover each code

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L248 · The key is accepted only as a bearer token, and nothing says so

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy

### Background

`extractBearer` reads `Authorization: Bearer <key>` and nothing else. That is a
reasonable choice, but it is only discoverable by reading `src/api/auth.ts`:
the README does not describe authentication, and a caller who sends
`X-API-Key`, a common convention and the one **Linq's own API uses**, gets a
401 saying the key is missing — which is confusing when they can see they sent
it.

### What to build

- Document authentication properly: the header, the format, how to get a key,
  what the quotas mean, and what each 401 code means (L247).
- A worked example that runs as written.
- Make the "missing key" message name the header it expected.
- Decide whether to also accept `X-API-Key`. Accepting both is friendlier;
  accepting one is simpler. Either way, write the decision down rather than
  leaving it implicit in a helper function.

### Acceptance criteria

- [ ] Authentication is documented where a new caller will find it
- [ ] The example works exactly as written
- [ ] The missing-key error names the expected header
- [ ] The decision on alternative headers is explicit
- [ ] No real key appears in any example

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L249 · A caller cannot see their own usage

**Labels:** help wanted, Stellar Wave, area:api-quality, difficulty:intermediate

### Background

`src/api/usage.ts` serves `/admin/usage/:keyId` and `/admin/usage`, both behind
`ADMIN_TOKEN`. Usage is metered per key, quotas are enforced per key, and the
only person who cannot see any of it is the person whose key it is.

So a caller discovers their quota by hitting it. For a paid API where exceeding
a quota can mean a 402 or a blocked request, that is the one number they need
in advance.

### What to build

- A route a caller reads with their **own** key, returning their own usage:
  requests used against each window, quota remaining, and when it resets.
- It must be impossible to read another key's usage through it. The key
  presented determines the answer — never a parameter.
- Reflect the same numbers the enforcement uses. Two sources of truth here means
  a caller is told they have room and then refused.
- `no-store` on the response: it is per-caller, and a shared cache must never
  hold it.

### Acceptance criteria

- [ ] A caller can read their own usage with their own key
- [ ] No parameter can make it return another key's usage
- [ ] The numbers match what enforcement uses
- [ ] The response is `no-store`
- [ ] A test asserts one key cannot see another's usage

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L250 · Admin routes are public and that is load-bearing

**Labels:** help wanted, Stellar Wave, area:security, difficulty:easy

### Background

Every admin route is registered with `config: { public: true }`:

```ts
app.post<{ Body: CreateKeyBody }>(
  '/admin/keys',
  { config: { public: true } },
  ...
```

It does not mean the route is public. It means "skip the API-key auth hook",
because these routes enforce `ADMIN_TOKEN` themselves — a key-minting endpoint
cannot require a key.

The trap is that `public: true` is also what genuinely public routes use, so
the same flag means two things, and the admin routes' real protection lives
further down the handler in a function that is easy to not notice — and that
exists in two copies (L232).

A route added to `admin.ts` by copying a neighbour inherits `public: true` and
is protected only if its author remembers the manual check.

### What to build

- Make the admin surface's protection structural rather than per-handler: a
  separate plugin or scope where the `ADMIN_TOKEN` check runs as a hook for
  every route inside it, so a new route is guarded by being in the right place.
- Distinguish "no auth" from "admin auth" in the route config, so reading a
  route definition tells the truth about who can call it.
- A test that enumerates registered routes and asserts every `/admin/*` path
  requires admin authorisation — the test that catches the route somebody adds
  next year.

### Acceptance criteria

- [ ] Admin routes are guarded by a hook, not by a call inside each handler
- [ ] Route config distinguishes genuinely public routes from admin-guarded ones
- [ ] A new route under `/admin` is protected by default
- [ ] A test asserts every registered `/admin/*` route rejects an unauthenticated request
- [ ] Genuinely public routes are unaffected

> **Drips Wave** · Complexity: **Easy** · **100 points**
