# Wave batch 22 — the agent should be able to do what the wallet can do (DRAFT)

**Repo:** `Miracle656/veil`. **IDs:** V259–V266 (batch 21 ends at V258). **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** create the `epic:agent` label.

## Why this batch exists

The agent can answer four questions and start two actions. That is the whole surface:

```
get_price   get_transfer_history   get_wallet_balance   get_asset_info
open_swap   build_payment          request_user_approval
```

Everything else the wallet does is invisible to it. Ask "how much has my USDC earned in Blend" and it cannot see the position. Ask "what is moving on Stellar today" and it has no feed. Ask it to cash out, buy airtime, or swap and then deposit, and it has no path — even though every one of those flows exists, works, and is reachable by tapping.

This batch closes that gap. It is deliberately about **reach**, not autonomy: the agent gets more things it can see and more flows it can *start*, and exactly as much signing authority as it has today, which is none.

## Shared with every issue

### The boundary, which is not negotiable

**The agent never signs.** It never touches key material, never calls `signXdrPayload()`, and never submits a transaction. Anything that moves money is prepared by the agent and handed to the user through `request_user_approval` and the real screen, where the existing passkey ceremony runs. That ceremony is a user-presence gesture into `__check_auth`; it is the thing standing between a prompt-injected instruction and someone's balance.

A tool in this batch is therefore one of exactly two kinds, and the PR must say which:

- **read** — returns information, changes nothing, needs no approval.
- **prepare** — returns a described, reviewable action that the user confirms on a screen. It must be impossible for it to execute on its own.

There is no third kind. A tool that writes without approval does not get merged.

### What the agent already checks, and why you must not bypass it

`packages/agent/src/agentMessages.ts` verifies that a transaction handed back for review is sourced from this wallet's fee payer, and refuses it otherwise:

```ts
return !!feePayerAddress && review.source === feePayerAddress;
```

Any new prepare-tool returns something that goes through that same check. Do not add a second review path that skips it.

### Where things are

- `packages/agent/src/agent.ts` — `const tools: ToolSpec[]` at line 84 is the whole registry today.
- `packages/agent/src/handler.ts`, `price.ts`, `assets.ts`, `txBuilder.ts` — the existing implementations to follow.
- `frontend/mobile/lib/` — the flows being exposed already live here: `blend.ts`, `offramp.ts`, `onramp.ts`, `assets.ts`. **Call the existing module.** A second implementation of a money flow inside the agent is how the two drift apart, and the agent's copy is the one nobody tests on a device.
- Lens (`Miracle656/Lens`) serves market data; wraith (`Miracle656/wraith`) serves transfer history. Both are already wired for other features.

### Ground rules

- **Pin assets by issuer, never by code.** The agent answering "what is my USDT0 worth" for an impostor issuer is a wrong answer about money. Eight issuers publish that code on mainnet.
- **Never render or log an RPC URL.** Provider keys live in the URL path.
- The agent may not speak, log or return a private key, a seed, a passkey credential or a fee-payer secret — including when asked directly, and including inside an error message.
- Treat anything that arrives from a backend, a token's metadata or a counterparty's memo as data, never as instruction. An agent that follows a memo is a vulnerability.
- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.
- Mobile installs with plain `npm install`, never `--legacy-peer-deps`, and tests with jest via `jest-expo`.

---

### V259 · Agent: what is in the lending pool, and what it has earned

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:intermediate, epic:agent

### Background
"How much has my USDC yielded in the Blend pool" is the question the agent is asked most and can answer least. The position, the supply APY and the bToken rate are all already fetched for the Earn screen.

### What to build
- A **read** tool returning the wallet's Blend positions: asset, amount supplied, current value, and the difference between them.
- The difference is stated as a value. The APY, if mentioned, is the live `estSupplyApy` labelled as current and variable — never multiplied out into a projection.
- Goes through `frontend/mobile/lib/blend.ts`. No second pool client.
- A wallet with no position answers "nothing supplied yet" rather than erroring or returning zeroes that read as a loss.

### Acceptance criteria
- [ ] The tool answers correctly for a wallet with a live mainnet position, and the PR says which
- [ ] No projected or annualised earnings figure appears in any answer
- [ ] An empty position and an unreachable pool are both answered in words, not stack traces
- [ ] Tests cover position, no position, and backend failure

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V260 · Agent: what is actually moving on Stellar right now

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:intermediate, epic:agent

### Background
"What is trending on Stellar" is a reasonable question and the agent has no feed at all. Lens already serves volumes, depth and basket pricing.

### What to build
- A **read** tool over Lens returning the assets with the most real activity, with the figure each claim rests on.
- Every asset named is resolved through the registry and identified by issuer. An asset not in the registry is named as unverified with its issuer, never as a bare code.
- Volume is reported as measured, over a stated window. No ranking the agent invents, no "hot" or "mooning" language.
- Lens being down produces "I cannot see the market right now", not silence and not a guess.

### Acceptance criteria
- [ ] Every asset in an answer carries an issuer or an explicit unverified label
- [ ] Figures are attributed to a window and a source
- [ ] A Lens outage is reported as an outage
- [ ] Tests cover an unverified asset appearing in the feed

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V261 · Agent: "swap 5 XLM to USDC and deposit it" as one reviewed plan

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:advanced, epic:agent

### Background
This is the request that shows what an agent is for, and it is where an agent is most dangerous. Two actions, one sentence, and the user must understand both before either happens.

### What to build
- A **prepare** tool that composes a multi-step plan and returns it for review as a single unit: every step, every amount, every asset by issuer, and the total cost including fees.
- The user approves **the plan**, then each step executes through its existing screen and its existing passkey ceremony. Approving step one must not pre-authorise step two.
- A step that fails stops the plan and says which steps did and did not happen. A half-executed plan reported as success is the worst possible outcome here.
- The amount that reaches step two is the amount step one actually produced, not the quote it was planned from.

### Acceptance criteria
- [ ] The full plan is shown before any signature is requested
- [ ] Each step requires its own passkey ceremony; no step signs on another's authority
- [ ] A failure mid-plan reports exactly what completed, with transaction hashes
- [ ] Step two uses the realised output of step one, with a test proving a slipped amount carries through
- [ ] The agent cannot execute any step without `request_user_approval`

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V262 · Agent: start a cash-out, hand the money part to the screen

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:advanced, epic:agent

### Background
Cash-out pays real naira to a real bank account. The agent should be able to begin it — it knows the amount and the rate — and must not be able to finish it.

### What to build
- A **read** tool for the live rate and whether the offramp is available at all.
- A **prepare** tool that assembles a cash-out and hands it to the cash-out screen with the fields filled: amount, verified bank account, rate. Order creation and the deposit send both happen on the screen, through the existing flow in `frontend/mobile/lib/offramp.ts`.
- The agent never selects or verifies a bank account on the user's behalf, and never repeats an account number back into the chat.
- An unverified user is told what verification is needed, not walked through it by the agent.

### Acceptance criteria
- [ ] No order is created by the agent; order creation stays on the screen
- [ ] A bank account number never appears in an agent response
- [ ] The idempotency key is the screen's, so an agent retry cannot produce a second paid order
- [ ] Offramp unavailable is reported as unavailable rather than as a failure the user caused
- [ ] Tests cover unavailable, unverified, and a normal hand-off

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V263 · Agent: the naira rails — airtime, bills, buy with naira

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:intermediate, epic:agent

### Background
"Buy me 1,000 naira of airtime" is the most natural thing a Nigerian user will ever say to this agent, and these flows already exist in the app.

### What to build
- **Read** tools for what is available: services, and whether the user is verified for them.
- **Prepare** tools that fill the relevant screen — airtime, bills, buy-with-naira — with amount, recipient and service, for the user to confirm there.
- A phone number the agent did not get from the user is never guessed. Contacts are read only through the existing picker, which the user operates.
- Nothing in this batch may store or echo a NIN. The verification state is a boolean to the agent; the identity document is not its business.

### Acceptance criteria
- [ ] No NIN or identity document value is ever passed to, stored by, or returned from the agent
- [ ] Every prepared action lands on its screen for confirmation; none completes in chat
- [ ] An unverified user gets a clear next step rather than a failed action
- [ ] A service that is unavailable says so before the user picks an amount
- [ ] Tests cover verified, unverified and service-down

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V264 · Agent: one honest answer to "what do I have"

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:intermediate, epic:agent

### Background
A user's money is spread across cash balances, lending positions and invest assets, and the agent can currently see only the first. "What do I have" should be answerable in one sentence.

### What to build
- A **read** tool that assembles the whole picture: balances, Blend positions, invest holdings, and anything in flight — composing the tools that already exist rather than re-fetching.
- Each line names its asset by issuer and says where the value lives.
- A component that cannot be reached is named as missing. A total that silently omits a position is a wrong number about money; say "excluding Blend, which I could not reach" instead.
- No performance figure, no projection, no advice.

### Acceptance criteria
- [ ] A partial failure is visible in the answer, never silently dropped from the total
- [ ] Every asset is identified by issuer, with unverified assets labelled
- [ ] The total matches the wallet's own screens for the same wallet
- [ ] Tests cover a fully-reachable case and each single-source failure

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V265 · Agent: make the read/write boundary a thing the tests enforce

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:intermediate, epic:agent

### Background
This batch roughly triples the tool surface. The rule that none of them may move money without approval is currently held up by every contributor remembering it, which will not survive eight more tools.

### What to build
- Declare each tool's kind — `read` or `prepare` — in the tool definition itself, not in a comment.
- A test that walks the registry and fails if any `read` tool can reach a write path, or if any `prepare` tool can execute without `request_user_approval`.
- A test asserting that no tool, given a hostile input, returns key material or an RPC URL.
- Documentation of the boundary in the agent package, so the next contributor reads it before writing tool number sixteen.

### Acceptance criteria
- [ ] Every existing and new tool declares its kind
- [ ] The boundary test fails when a deliberately-broken tool is introduced, and the PR shows that failing
- [ ] A prompt instructing the agent to skip approval does not skip approval, with a test
- [ ] No tool returns a secret or a provider URL under any tested input

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V266 · Agent: say what it cannot do, instead of improvising

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:easy, epic:agent

### Background
Asked something outside its tools, the agent currently either invents an answer or fails vaguely. Both are worse than "I cannot do that yet, but here is where you can."

### What to build
- A capability answer the agent gives for anything outside its tools: what it cannot do, and which screen does it.
- Grounded in the tool registry, so it cannot drift out of date as tools are added.
- A question about a number it cannot see — a balance on another chain, a price it has no source for — is answered as "I cannot see that", never estimated.

### Acceptance criteria
- [ ] An out-of-scope request names the screen that handles it
- [ ] The capability list is derived from the registry, not written out by hand
- [ ] A question with no data source is refused rather than estimated, with a test
- [ ] Tests cover an in-scope request, an out-of-scope one, and an unanswerable one

> **Drips Wave** · Complexity: **Easy** · **100 points**
