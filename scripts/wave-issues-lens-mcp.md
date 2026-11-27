# Wave batch — Lens MCP & the agent surface (L209–L230)

Drafted 2026-10-17 by reading `Divinity-Labs/Lens` at `8e966ef`. Checked against
the 136 open issues first — only #349 touches MCP, and nothing here duplicates
it or #215–#217 on CEX adapters.

The theme: Lens ships an MCP server so that agents can use it. It is 179 lines,
it exposes two tools, and **neither of them is about Lens**. One searches an
arbitrary Bazaar node; the other spends real money at a URL the agent chooses.
Meanwhile the price data this entire service exists to produce is not reachable
from an agent at all.

So this batch is two halves: close the holes in the tool that spends money, and
give an agent something worth calling.

## Shared with every issue

**Repo:** `Divinity-Labs/Lens`. The MCP server is `src/mcp/server.ts`
(`BazaarMcpServer`) with error codes in `src/mcp/codes.ts`. It is started by
`npm run mcp:server` → `examples/mcp-server/run.ts`, and there is an agent
example at `examples/mcp-server/agent.ts`. Tests are `tests/mcp.test.ts`.

**Run the tests:** `npm test`. **The tests are vitest, not jest.** A single file
is `npx vitest run tests/mcp.test.ts`.

**`Load test (prices)` is already failing on `main`.** Not your PR.

**This surface signs with a real mainnet key.** `examples/mcp-server/run.ts`
requires `MCP_AGENT_SECRET_KEY_MAINNET` and builds a signer for
`stellar:pubnet`. Anything you change here can move real money, so prefer
failing closed, and never log, echo or test with a real secret key.

**Never elide an address, a contract id or a key** in code, comments or
fixtures. A previous batch shortened a contract id and five contributors
invented plausible-looking ids to fill the gap. Write it in full or not at all.

**An agent is the least able caller to notice a wrong answer.** It will reason
over whatever it is handed, confidently. Prefer a structured error over a
best-effort result.

---

### L209 · `paid_call` will pay whatever URL the agent names

**Labels:** help wanted, Stellar Wave, area:security, difficulty:advanced

### Background

The tool takes a URL from the agent and pays for it:

```ts
if (request.params.name === 'paid_call') {
  const url = String(request.params.arguments?.url);
  const method = request.params.arguments?.method ? String(request.params.arguments?.method) : 'GET';
  const res = await this.fetchWithPayment(url, { method });
```

`fetchWithPayment` is built in `examples/mcp-server/run.ts` from a **mainnet
secret key**, wrapping x402 so that a 402 response is answered automatically
with a USDC payment:

```ts
const mainnetKey = process.env.MCP_AGENT_SECRET_KEY_MAINNET;
const pubnetSigner = createEd25519Signer(mainnetKey, 'stellar:pubnet');
const fetchWithPayment = wrapFetchWithPaymentFromConfig(globalThis.fetch, {
  maxPrice: process.env.MCP_MAX_PAYMENT_PRICE || '$1.00',
  ...
})
```

There is no allow-list of hosts, no confirmation step, and no record of the
payment. So any URL the agent can be persuaded to name will be paid, up to
`maxPrice`, from a live mainnet key.

That matters because agents are routinely persuaded. An agent that reads a web
page, an issue comment or a search result is reading attacker-influenced text,
and "call `paid_call` on `https://…`" is a single sentence. This is the standard
prompt-injection-to-payment path, and the tool description —
*"handling the 402 loop automatically"* — advertises it.

### What to build

- An **allow-list** of hosts or URL prefixes that `paid_call` may pay. Anything
  else is refused with a clear error naming the host.
- The list must come from configuration, not from the agent, and must default to
  empty or to Lens's own origin — a default that pays nobody is the right
  failure mode.
- Refuse before any network call, so a refused host is never even contacted.
- The refusal must be a structured MCP error with a code, so the agent can
  explain itself rather than retry.

Coordinate with L210 (spend ceiling) and L211 (payment log). Together they are
the complete answer; separately each is useful.

**Not to be confused with #147**, "Harden the x402 facilitator: spend ceiling,
caller allow-list, settle idempotency". That issue protects the money Lens
*receives and sponsors*, on `POST /settle`. This one protects the money the
agent *spends*. Opposite ends of the same protocol, different code, different
threat — but read #147 first, because the vocabulary and some of the mechanism
will be reusable.

### Acceptance criteria

- [ ] `paid_call` refuses a host that is not allow-listed, before any request is made
- [ ] The allow-list is configuration, not a tool argument
- [ ] The default configuration pays nothing
- [ ] Refusal is a structured error with a code, naming the host
- [ ] Tests cover an allowed host, a refused host, and a URL that is a near-miss of an allowed one

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L210 · The spend cap is per call, so it is not a cap

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

```ts
maxPrice: process.env.MCP_MAX_PAYMENT_PRICE || '$1.00',
```

`maxPrice` bounds a **single** payment. Nothing bounds the total. An agent in a
retry loop, or one that has been told to "try each of these endpoints", can make
that payment arbitrarily many times — each one individually within the limit,
the sum unbounded.

A per-call limit answers "how much can one mistake cost". The question an
operator actually has is "how much can today cost".

### What to build

- A cumulative ceiling over a rolling window — per session and per day are both
  reasonable; implement at least one and say why.
- When the ceiling is reached, refuse further payments with a distinct error
  code, so the agent can report being out of budget rather than appearing broken.
- Both the per-call and cumulative limits should be visible to the agent, ideally
  in the tool description, so it can reason about cost before calling.
- Persist the running total somewhere that survives a restart, or document
  clearly that it does not and why that is acceptable.

### Acceptance criteria

- [ ] A cumulative spend ceiling exists and is configurable
- [ ] Reaching it produces a distinct, documented error code
- [ ] The remaining budget is discoverable by the agent
- [ ] Restart behaviour is deliberate and documented
- [ ] A test proves N calls under the per-call limit are refused once their sum exceeds the ceiling

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L211 · Nothing records what the agent spent

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:intermediate

### Background

A successful `paid_call` returns the response body and nothing else. There is no
log line, no metric and no persisted record of: which URL was paid, how much,
on which network, with which transaction.

So after a day of agent activity there is no way to answer "what did we spend
and on what" except by reading the Stellar ledger for the key's account and
reverse-engineering it.

For a tool that moves money, the audit trail is not an enhancement.

### What to build

- A durable record per payment: timestamp, URL, host, method, amount, network,
  transaction hash, and the outcome.
- A counter and a sum as Prometheus metrics, labelled by **host** and network —
  keep the label set bounded, so an allow-listed host set (L209) is the natural
  label domain.
- Surface the running total so L210's ceiling has something to read.
- Never record the secret key or the signed envelope.

### Acceptance criteria

- [ ] Every payment attempt is recorded, successful or not
- [ ] The record includes the transaction hash where one exists
- [ ] Spend is exported as a metric with bounded labels
- [ ] No secret material is recorded
- [ ] A test asserts a failed payment is recorded as an attempt

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L212 · `bazaar_search` will fetch any URL it is given

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

```ts
const endpoint = query
  ? `${url.replace(/\/$/, '')}/discovery/search?q=${encodeURIComponent(query)}`
  : `${url.replace(/\/$/, '')}/discovery/resources`;

const res = await fetch(endpoint);
```

The `url` argument comes from the agent and is passed to `fetch` after nothing
more than a trailing-slash trim. It is not parsed, the scheme is not checked,
and the host is not constrained.

This is a server-side request forgery primitive. The MCP server runs wherever
the operator runs it — frequently a machine with network access that the agent
does not have — and will fetch, for example, a cloud instance metadata endpoint
or a service on a private address, then hand the response body back to the agent
as text.

It is the same class of problem as L209 without the money, which makes it easier
to overlook and just as real.

### What to build

- Parse the URL properly and reject anything that is not `http`/`https`.
- Constrain the host the same way L209 constrains payment, ideally sharing the
  configuration so an operator maintains one list.
- Block requests to private, loopback, link-local and metadata addresses, and
  do it **after** DNS resolution — a public hostname can resolve to a private
  address, which is how this is usually bypassed.
- Do not follow redirects blindly; a permitted host can redirect to a forbidden
  one.

### Acceptance criteria

- [ ] Non-HTTP schemes are rejected
- [ ] Private, loopback, link-local and metadata addresses are refused
- [ ] The check happens after DNS resolution, not only on the literal string
- [ ] Redirects are not followed to a host that would itself be refused
- [ ] Tests cover a private literal, a hostname resolving to a private address, and a redirect to one

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L213 · An agent cannot ask Lens for a price

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:advanced

### Background

The MCP server exposes exactly two tools, `bazaar_search` and `paid_call`.
Neither returns a price. The service aggregates SDEX, AMM, Soroswap and Aquarius
into a VWAP with a best route and a confidence, serves it over REST, GraphQL and
a websocket — and an agent connected over MCP cannot reach any of it.

This is the single largest gap in the agent story: the MCP server is a client
for *other people's* Bazaar nodes, not a server for Lens's own data.

### What to build

- A `lens_get_price` tool returning the aggregated price for a pair: value,
  sources, confidence, last-trade age, best route.
- Assets must be expressible **with their issuers** — a tool that takes a bare
  code will answer about the wrong asset, which is live bug #357 on the GraphQL
  surface and was bug `41b1f62` on REST. Do not make the same mistake a third
  time.
- Network selectable, defaulting to the active network.
- A tool description precise enough that an agent chooses it correctly, and an
  `inputSchema` strict enough that it cannot be called wrongly.
- The result should be structured content, not a wall of prose, so the agent can
  use the number without parsing English.

### Acceptance criteria

- [ ] A price tool exists and returns the aggregated price for a pair
- [ ] Assets can be given with issuer, and an issuer mismatch does not silently match
- [ ] The network is selectable and defaults sensibly
- [ ] Staleness is reported, so an agent can tell an old price from a current one
- [ ] Tests cover a known pair, an unknown pair, and an issuer mismatch

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L214 · No tool exposes pairs, pools or the screener

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:intermediate

### Background

Once L213 gives an agent a price, the next three questions are "what pairs exist",
"what liquidity is behind this" and "what is moving". REST answers all three —
`/pairs`, `/pools`, `/screener` — and MCP answers none.

Without `listPairs`, an agent cannot even discover what to ask a price about; it
has to guess asset codes, which is exactly how an agent ends up confidently
asking about an asset that does not exist.

### What to build

- `lens_list_pairs`, `lens_get_pools` and `lens_screen_pairs` tools over the
  existing implementations — share the code with the routes, do not reimplement
  the queries.
- Results must be paginated or bounded. An agent given 500 pairs in one response
  spends its context on them.
- Every asset in a result carries its issuer in full.
- Tool descriptions should say when to use each one — the difference between
  "list pairs" and "screen pairs" is not obvious from the names alone.

### Acceptance criteria

- [ ] All three tools exist and share their implementations with the REST routes
- [ ] Results are bounded, with a documented way to get the next page
- [ ] Issuers appear in full, never shortened
- [ ] Descriptions distinguish the tools from one another
- [ ] Tests assert parity with the corresponding REST route

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L215 · Errors are classified by searching the message text

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:intermediate

### Background

```ts
private handlePaidCallError(e: any) {
  const msg = String(e.message || e).toLowerCase();

  if (msg.includes('signatureexpirationledger') || msg.includes('signature expired')) { … }
  if (msg.includes('trustline') || msg.includes('op_no_trust')) { … }
  if (msg.includes('insufficient') || msg.includes('underfunded')) { … }
  if (msg.includes('fetch') || msg.includes('network')) { … }
  return this.createErrorResponse('ERR_INTERNAL_FAILURE', …)
}
```

The error codes are good and the mapping is the right idea. The mechanism is the
problem: it depends on the wording of messages produced by the Stellar SDK and
the x402 libraries, neither of which treats its message text as an API. A library
upgrade that rephrases "underfunded" silently reclassifies a funding problem as
an internal failure, and the agent is told something untrue.

`msg.includes('fetch')` is the loosest of them — any message containing the word,
including one about a failed *payment*, is reported as the service being
unreachable.

### What to build

- Classify on structured signals first: an error class, a code property, a
  Horizon `result_codes` body, an HTTP status. Fall back to text only when
  nothing structured exists, and mark that path clearly as a fallback.
- The raw error must still reach the logs in full, whatever the classification.
- Order the checks so the most specific wins; `fetch` must not shadow a payment
  failure.
- Tests should assert against realistic error shapes from the actual libraries,
  not hand-written strings — the current four tests pass strings, which is why
  this fragility is invisible.

### Acceptance criteria

- [ ] Classification uses structured properties where they exist
- [ ] Text matching is a clearly-marked fallback
- [ ] A payment failure whose message contains "fetch" is not reported as unreachable
- [ ] The unclassified case preserves the original message in logs
- [ ] Tests use realistic error objects, not only strings

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L216 · Tool arguments are coerced with `String()` and never validated

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:easy

### Background

```ts
const url = String(request.params.arguments?.url);
const method = request.params.arguments?.method ? String(request.params.arguments?.method) : 'GET';
```

`String(undefined)` is the string `"undefined"`, so a call with no `url` produces
a fetch against `"undefined/discovery/resources"` rather than a clear error about
a missing argument. `method` is accepted as any string at all — including one
that is not an HTTP method.

The `inputSchema` on each tool declares `required: ['url']`, but nothing in this
code path enforces it; the SDK does not validate arguments against the schema for
you.

### What to build

- Validate arguments against a schema at the top of the handler — zod is already
  a dependency and is used for route validation elsewhere in this repo.
- Derive the advertised `inputSchema` from the same definition, so the schema an
  agent reads and the rules the server enforces cannot drift.
- A missing or wrongly-typed argument is a structured error naming the argument.
- Constrain `method` to a known set.

### Acceptance criteria

- [ ] Arguments are validated before use
- [ ] A missing `url` produces an error naming it, not a fetch to "undefined"
- [ ] `method` is restricted to a documented set
- [ ] The advertised schema and the enforced rules come from one definition
- [ ] Tests cover missing, wrongly-typed and out-of-range arguments

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L217 · Running on testnet requires a mainnet key

**Labels:** help wanted, Stellar Wave, area:config, difficulty:easy

### Background

```ts
if (!testnetKey || !mainnetKey) {
  console.error('[mcp-server] Error: MCP_AGENT_SECRET_KEY_TESTNET and MCP_AGENT_SECRET_KEY_MAINNET must be set');
  process.exit(1);
}
```

Both keys are mandatory. A contributor who wants to try the MCP server against
testnet must put a **mainnet** secret key in their environment to get past
startup — and then runs a server that can spend it.

The safest configuration is the one that is hardest to reach, which is backwards.

### What to build

- Require only the key for the network actually in use; start with whichever
  schemes are configured.
- Starting with mainnet configured should be an explicit opt-in, and should log
  clearly at startup that real funds are reachable.
- If no key is present, the payment tool should be absent or refuse, rather than
  the process failing to start — a read-only MCP server is useful.

### Acceptance criteria

- [ ] The server starts with only a testnet key configured
- [ ] Mainnet is opt-in and announced at startup
- [ ] With no key at all, the server still starts and the paying tool refuses
- [ ] The error for a missing key names which network needed it
- [ ] No key value is ever logged

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L218 · The MCP environment variables escape the drift guard

**Labels:** help wanted, Stellar Wave, area:config, difficulty:easy

### Background

`examples/mcp-server/run.ts` reads four variables —
`MCP_AGENT_SECRET_KEY_TESTNET`, `MCP_AGENT_SECRET_KEY_MAINNET`,
`MCP_MAX_PAYMENT_PRICE` — and **none of them appears in `.env.example`**.

The repo has a drift guard, `src/__tests__/envDrift.test.ts`, that fails CI when
a variable is read in source but undocumented. It scans `src/`. These reads are
in `examples/`, so they are invisible to it.

The result is that the most dangerous variable in the project — a mainnet secret
key — is the one piece of configuration nothing documents or checks.

### What to build

- Document all MCP variables in `.env.example`, with what they are for and the
  consequence of setting them. The mainnet key deserves an explicit warning.
- Extend the drift guard to cover `examples/` as well as `src/`, or justify in a
  comment why it should not.
- Check whether any other directory reads `process.env` outside the guard's
  reach, and cover those too.

### Acceptance criteria

- [ ] Every MCP variable is documented in `.env.example`
- [ ] The drift guard covers the directories where variables are actually read
- [ ] The guard fails on a newly added undocumented variable in `examples/`
- [ ] No real key value appears anywhere in the repo
- [ ] The mainnet key's documentation states plainly that it can spend funds

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L219 · An empty result is reported as an error

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:easy

### Background

```ts
if ((Array.isArray(data) && data.length === 0) || (hasResources(data) && data.resources.length === 0)) {
  return this.createErrorResponse('ERR_NO_RESULTS', 'No resources found');
}
```

A search that ran correctly and found nothing comes back with `isError: true`.
"I searched and there were none" is a successful search, and an agent handed an
error will usually retry, rephrase, or report a failure to the user — none of
which is the right response to an empty set.

It also makes a genuinely empty result indistinguishable from a broken one at a
glance, which is the same confusion L163 describes on the ingestion side.

### What to build

- Return an empty result as a **success** with an empty collection.
- Keep a distinct error for the cases that really are errors: unreachable,
  malformed response, refused host.
- Make the empty case explicit in the response shape — an empty list and a count
  of zero, rather than an absence the agent has to infer.
- Check the other tools for the same pattern.

### Acceptance criteria

- [ ] An empty search succeeds with an empty collection
- [ ] `ERR_NO_RESULTS` is removed or reserved for a genuinely exceptional case
- [ ] Real failures remain errors
- [ ] The response distinguishes "none" from "could not tell"
- [ ] A test asserts an empty search is not an error

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L220 · An unknown tool name throws a raw exception

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:easy

### Background

```ts
throw new Error(`Unknown tool: ${request.params.name}`);
```

Every other failure in this file returns a structured MCP error with a code.
This one throws, so the agent receives a protocol-level exception instead of a
tool error it can reason about — a different shape for what is, from the agent's
point of view, the most ordinary mistake it can make.

The thrown message also echoes the agent-supplied tool name back verbatim.

### What to build

- Return a structured error with a code, consistent with the rest of the file.
- Include the list of valid tool names, so the agent can correct itself in one
  step rather than guessing again.
- Treat the supplied name as untrusted input in the message — bound its length
  and do not interpolate it raw.
- Check the handler for any other throw that should be a structured error.

### Acceptance criteria

- [ ] An unknown tool returns a structured error, not a thrown exception
- [ ] The error lists valid tool names
- [ ] The echoed name is length-bounded and sanitised
- [ ] No other path in the handler throws where it should return
- [ ] A test asserts the shape of the unknown-tool response

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L221 · Tool results are unbounded

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:intermediate

### Background

```ts
return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
```

Whatever the upstream returned is serialised in full, pretty-printed, into the
agent's context. A Bazaar node with a large resource list — or a hostile one
returning megabytes — fills the agent's context window in one call, and
pretty-printing inflates it further for no benefit to a machine reader.

An agent that has spent its context on one tool result cannot do the task it was
called for, and the failure looks like the model being bad rather than the tool
being unbounded.

### What to build

- Cap the response size, and say clearly in the result when it was truncated —
  silent truncation is worse than the overflow.
- Drop the pretty-printing; indentation is for humans.
- Where a result is a collection, prefer returning a bounded page plus a count,
  with a documented way to ask for more. Coordinate with L214.
- Cap what is read from the upstream response too, so a hostile body is never
  fully buffered in the first place.

### Acceptance criteria

- [ ] Tool results are size-bounded with a configurable limit
- [ ] Truncation is explicit in the response
- [ ] Output is not pretty-printed
- [ ] An oversized upstream body is not buffered in full
- [ ] A test covers a response that exceeds the limit

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L222 · Nothing limits how fast an agent can call

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:intermediate

### Background

Tool calls are handled as they arrive. There is no rate limit, no concurrency
cap and no queue, so an agent in a loop — which is the normal failure mode of an
agent, not an exotic one — can issue calls as fast as it can generate them.

With `paid_call` in the tool list, that loop costs money (L210). With
`bazaar_search` it costs an unbounded number of outbound connections from the
host the server runs on.

### What to build

- A concurrency cap on in-flight tool calls, and a rate limit per tool.
- Exceeding it should be a structured error that tells the agent to slow down,
  with a retry hint — not a silent queue that makes the agent think it is hanging.
- Expensive tools deserve tighter limits than cheap ones; make the limit
  per-tool rather than global.
- Count rejections in a metric so a looping agent is visible rather than merely
  expensive.

### Acceptance criteria

- [ ] In-flight tool calls are capped
- [ ] A per-tool rate limit exists and is configurable
- [ ] Exceeding a limit returns a structured error with a retry hint
- [ ] Rejections are counted in a metric
- [ ] A test proves a burst is throttled rather than queued indefinitely

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L223 · The server advertises only tools, not resources

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:intermediate

### Background

```ts
capabilities: {
  tools: {},
}
```

MCP has a `resources` capability for content an agent can read directly rather
than by calling a function. Lens has obvious candidates: the list of watched
pairs, the OpenAPI document, the venue list, the current status.

Exposing them as resources rather than tools means an agent can attach them to
its context once instead of calling a tool repeatedly for data that barely
changes — cheaper for the agent and for the service.

### What to build

- Declare the `resources` capability and implement listing and reading.
- Start with the stable, cacheable things: watched pairs, venues, the OpenAPI
  document, service status.
- Give each a stable URI and an accurate MIME type.
- Report an honest last-modified or version, so an agent can tell whether what it
  cached is still current.

### Acceptance criteria

- [ ] The server declares and implements `resources`
- [ ] At least the pair list and the OpenAPI document are exposed
- [ ] URIs are stable and documented
- [ ] Each resource reports accurate freshness information
- [ ] Tests cover listing and reading a resource

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L224 · There is no HTTP transport, only stdio

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:intermediate

### Background

```ts
async run() {
  const transport = new StdioServerTransport();
  await this.server.connect(transport);
}
```

Stdio is the right default for a locally-launched server, and it is the only
option here. That means the MCP server can only be used by a client able to
spawn a process on the same machine — so a hosted Lens cannot offer MCP to
anyone at all.

Given that Lens is a hosted price API, the transport it cannot speak is the one
most of its users would need.

### What to build

- Support a streamable HTTP transport alongside stdio, selected by configuration.
- HTTP exposure needs authentication — an unauthenticated remote MCP server with
  `paid_call` in its tool list is L209 with the door held open. Require a key
  and refuse without one.
- Keep stdio the default so nothing currently working changes.
- Document how to run each, and what each is for.

### Acceptance criteria

- [ ] An HTTP transport is available and selected by configuration
- [ ] Stdio remains the default
- [ ] The HTTP transport requires authentication and refuses without it
- [ ] Both transports expose identical tools
- [ ] The README documents running each

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L225 · The server version is a hard-coded string

**Labels:** help wanted, Stellar Wave, area:dx, difficulty:easy

### Background

```ts
this.server = new Server({ name: 'bazaar-mcp-server', version: '1.0.0' }, …)
```

Clients read the advertised version during initialisation to decide what a server
supports. This one is a literal that has never changed and is unrelated to the
package version, so every build of Lens ever shipped claims to be the same MCP
server.

When a client reports a bug, the version it saw tells us nothing.

### What to build

- Derive the version from `package.json` at build time.
- Make the name accurate too — `bazaar-mcp-server` describes the two Bazaar
  tools, and L213/L214 are about to make this a Lens server. Rename deliberately,
  and note that clients may key configuration on the name.
- A test asserting the advertised version matches the package version, so it
  cannot drift back.

### Acceptance criteria

- [ ] The advertised version comes from `package.json`
- [ ] A test fails when they disagree
- [ ] The server name reflects what the server is
- [ ] Any rename is called out in the changeset as potentially client-affecting
- [ ] Nothing else reads the hard-coded literal

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L226 · Only the error paths of one tool are tested

**Labels:** help wanted, Stellar Wave, area:testing, difficulty:intermediate

### Background

`tests/mcp.test.ts` has four tests, all on `paid_call`:

```
should map signature expiration ledger error to ERR_EXPIRED_AUTHORISATION
should map missing trustline error to ERR_MISSING_TRUSTLINE
should map 402 rejected error to ERR_PAYMENT_REJECTED
should return successfully on a successful call
```

`bazaar_search` has no tests at all — not the query path, not the empty-result
path, not the non-2xx path. `ListTools` is never exercised, so a malformed tool
schema would ship unnoticed.

The four that exist also construct errors as plain strings, which is what makes
L215's text-matching fragility invisible to the suite.

### What to build

- Cover `bazaar_search`: with and without a query, empty results, non-2xx, a
  malformed body.
- Cover `ListTools`: the advertised tools, and that each `inputSchema` is valid.
- Cover the unknown-tool path.
- Where an upstream error is simulated, use a shape resembling what the real
  library throws.

### Acceptance criteria

- [ ] `bazaar_search` has tests for success, empty, non-2xx and malformed body
- [ ] `ListTools` is exercised and each schema validated
- [ ] The unknown-tool path is covered
- [ ] Simulated errors resemble real ones
- [ ] The four existing tests still pass

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L227 · The agent example is undocumented

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy

### Background

`package.json` exposes two commands:

```json
"mcp:server": "tsx examples/mcp-server/run.ts",
"mcp:agent": "tsx examples/mcp-server/agent.ts"
```

Neither is explained anywhere a reader would look. There is no README in
`examples/mcp-server/`, nothing in the repo README, and no description of what
the agent example does, what it needs, or what it will spend.

Someone who runs `npm run mcp:server` without reading the source will discover
its requirements through a startup failure, and its behaviour by watching it.
For a tool that signs with a mainnet key, that is the wrong order.

### What to build

- A README in `examples/mcp-server/` covering what each command does, what
  configuration it needs, which network it talks to, and what it can spend.
- A worked example of connecting a client and calling each tool.
- A prominent warning about the mainnet key, with the safe way to try it first.
- A link from the repo README, next to the REST and GraphQL documentation.
- Every example runnable exactly as written.

### Acceptance criteria

- [ ] `examples/mcp-server/README.md` exists and is linked from the repo README
- [ ] Both npm commands are documented with their configuration
- [ ] The spending risk is stated prominently
- [ ] A client connection example is included and works as written
- [ ] No key, address or contract id in any example is shortened

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L228 · No test drives a real 402 payment loop

**Labels:** help wanted, Stellar Wave, area:testing, difficulty:advanced

### Background

The 402 test asserts that a **rejected** payment maps to `ERR_PAYMENT_REJECTED`.
Nothing tests the path where a 402 is answered successfully: the payment is
constructed, signed, submitted and the resource returned.

That path is the reason this tool exists, it is the one that moves money, and it
is the one that would break silently on an x402 or Stellar SDK upgrade — which
is not hypothetical, since this repo currently pins `@stellar/stellar-sdk` at a
major four behind current.

### What to build

- An end-to-end test of the successful 402 loop against a stubbed resource that
  demands payment and verifies it — a fake facilitator, not mainnet.
- Assert on what was signed: amount, destination, network passphrase. A test that
  only checks the response body would pass while paying the wrong account.
- Cover the failure branches too: wrong network, expired signature, amount above
  `maxPrice`.
- **Testnet keys only**, generated by the test, never committed and never a real
  account.

### Acceptance criteria

- [ ] A successful 402 loop is tested end to end against a stub
- [ ] Assertions cover amount, destination and network, not just the response
- [ ] Payment above `maxPrice` is refused, asserted
- [ ] No real key or mainnet account is used
- [ ] The test is deterministic and needs no network access

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L229 · Tool descriptions do not tell an agent when to stop

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:easy

### Background

```
'Search for resources in a Stellar Bazaar node'
'Make a paid API call to a Bazaar resource, handling the 402 loop automatically.'
```

A tool description is the only instruction an agent gets. The second one says
payment is handled automatically and says nothing about cost, limits, or the
fact that real funds move — so an agent reasoning about whether to call it has
no basis to hesitate, and "automatically" actively encourages it not to.

The descriptions also do not say what the tools cannot do, which is what stops
an agent calling the wrong one repeatedly.

### What to build

- Rewrite both descriptions to state what the tool does, what it costs, what it
  requires, and when **not** to use it.
- `paid_call` must say that it spends real funds and name the per-call limit.
- Describe each argument in its schema, including the format expected.
- Where L209's allow-list exists, say that only permitted hosts can be paid — an
  agent that knows the rule will not waste turns discovering it.

### Acceptance criteria

- [ ] Each description states purpose, cost and preconditions
- [ ] `paid_call` explicitly says real funds move, and names the limit
- [ ] Every argument has a description and a stated format
- [ ] Descriptions say when not to use the tool
- [ ] No description promises behaviour the code does not implement

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L230 · The MCP server has no metrics

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:easy

### Background

`src/metrics.ts` knows nothing about MCP. There is no count of tool calls, no
duration, no error breakdown — so the agent surface is entirely invisible on the
dashboard that covers every other part of the service.

Once L213 and L214 give agents something worth calling, "which tools are
actually used" becomes the question that decides what to build next, and there
will be no data to answer it.

### What to build

- A counter of tool calls by tool name and outcome. Tool names are a fixed,
  server-defined set, so this label is safely bounded — unlike the GraphQL
  operation names in #374.
- A histogram of tool call duration by tool.
- A counter of errors by the `MCP_ERROR_CODES` value, which is already a closed
  set and is exactly the right label domain.
- Register on the existing registry so everything appears at `/metrics`.

### Acceptance criteria

- [ ] Tool calls are counted by name and outcome
- [ ] Duration is recorded per tool
- [ ] Errors are counted by error code
- [ ] All labels come from closed sets
- [ ] Metrics appear on the existing `/metrics` endpoint

> **Drips Wave** · Complexity: **Easy** · **100 points**
