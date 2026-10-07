# Wave batch 17 — DeepSeek as an agent provider (DRAFT)

**Source:** verified against DeepSeek's own API docs on 2026-09-24. **Repo:** `Miracle656/veil`. **IDs:** V210. **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** `area:agent` and `epic:agent` already exist.

## Shared with every issue

### DeepSeek API facts, verified 2026-09-24

Checked against <https://api-docs.deepseek.com/quick_start/pricing/>. Re-check before you build — DeepSeek renames models fairly often, and the older `deepseek-chat` / `deepseek-reasoner` identifiers you will find in blog posts are out of date.

| | |
|---|---|
| OpenAI-format base URL | `https://api.deepseek.com` |
| Anthropic-format base URL | `https://api.deepseek.com/anthropic` |
| Models | `deepseek-flash` (DeepSeek-V4.1-Flash, supports vision) · `deepseek-v4-pro` (DeepSeek-V4-Pro-0813, no vision) |
| Tool / function calling | supported on both |
| `deepseek-flash` price | $0.15–$0.30 per 1M input (cache miss), $0.60–$1.20 per 1M output |
| `deepseek-v4-pro` price | $0.66–$1.32 per 1M input (cache miss), $1.98–$3.96 per 1M output |
| Cache hits | $0.003–$0.006 per 1M on flash — roughly 50× cheaper than a miss |

Prices are a range because DeepSeek bills peak and off-peak differently. Peak is 01:00–04:00 and 06:00–10:00 UTC on weekdays; everything else, including weekends, is off-peak at about half price.

### The key is an environment variable and nothing else

`DEEPSEEK_API_KEY` is set in the deployment environment by the maintainer. It must never appear in a committed file, a test fixture, a log line, an error message, or a `.env` that is not `.env.example`. Add the name to `.env.example` with an empty value and a comment; never the value.

---

### V210 · Add DeepSeek as an agent provider

**Labels:** help wanted, Stellar Wave, area:agent, difficulty:intermediate, epic:agent

### Background
`packages/agent/src/llm.ts` already has the shape this needs. `LlmProvider` is a two-member interface — a `label` and a `start()` returning an `LlmSession` — and there are two implementations behind it: `anthropicProvider()` and `openRouterProvider()`. `providerFromEnv()` picks between them from `LLM_PROVIDER` and the presence of `OPENROUTER_API_KEY`.

So this is not a new architecture, it is a third provider and one more branch in that selector.

There is a reason to want it. The agent currently runs on OpenRouter's free models, which are rate limited to 20 requests a minute and 50 a day, return empty content often enough that `completeWithFallback` has to skip them, and disappear without notice. DeepSeek is paid but cheap enough to be a real default: `deepseek-flash` at $0.15–$0.30 per million input tokens is a fraction of Claude, it supports tool calling, and its cache-hit rate is billed at roughly 50× less than a miss — which matters here, because the agent resends a long system prompt on every turn.

### What to build

- **`deepseekProvider({ apiKey, model })` in `packages/agent/src/llm.ts`**, implementing `LlmProvider`.

  Decide deliberately which of the two endpoints to build on, and say why in the PR:
  - The **OpenAI-format** endpoint (`https://api.deepseek.com`) has the same request and response shape as `openRouterProvider`, so most of the message mapping, the tool-call translation and the error handling can be shared rather than written again. Prefer this unless there is a concrete reason not to.
  - The **Anthropic-format** endpoint (`https://api.deepseek.com/anthropic`) would let `anthropicProvider` be reused with a different base URL, but that provider is built around Claude's thinking blocks and a 16,000-token output budget sized for them, which DeepSeek does not share.

  Whichever you choose, do not copy a whole provider to change three lines. Extract the shared part.

- **Model from env, with a sane default.** `DEEPSEEK_MODEL` overrides; default to `deepseek-flash`. Export the default as a named constant the way `DEFAULT_CLAUDE_MODEL` is, so it is greppable.

- **Wire `providerFromEnv()`**: `LLM_PROVIDER=deepseek` forces it, and `DEEPSEEK_API_KEY` alone selects it when nothing else is forced. Keep the existing precedence intact — do not change which provider an existing deployment gets. A deployment with only `OPENROUTER_API_KEY` set must still get OpenRouter.

- **Fail clearly.** `LLM_PROVIDER=deepseek` with no key should throw the same shape of error `openrouter` does today, naming the variable.

- **Report it honestly in `label`**, because `/api/agent` health output and the logs use it to say which model answered.

### Errors worth handling specifically

The agent has been broken three times by provider-side failures that were not obviously provider-side. Please handle these rather than letting them surface as a generic 502:

- **Insufficient balance.** DeepSeek is prepaid; a dry account returns an error rather than a rate limit. That must be distinguishable in the logs from a key problem, because the fix is completely different.
- **Rate limiting**, distinguished from an upstream model failure — `isUpstreamFailure()` already draws that line for OpenRouter and the same distinction applies.
- **An empty reply.** The existing OpenRouter path already skips a model that returns empty content; do not let DeepSeek return a blank turn into the tool loop.

### Key files
- `packages/agent/src/llm.ts`
- `packages/agent/src/__tests__/` (new test file)
- `frontend/wallet/.env.example` — add `DEEPSEEK_API_KEY=` and `DEEPSEEK_MODEL=` with comments, empty values

### Acceptance criteria
- [ ] `LLM_PROVIDER=deepseek` with `DEEPSEEK_API_KEY` set returns a working provider whose `label` names the model
- [ ] A multi-turn tool call completes — the agent's existing tools (balance, price, swap) work through it end to end
- [ ] Existing deployments are unaffected: with only `OPENROUTER_API_KEY` set, `providerFromEnv()` still returns OpenRouter, and with only `ANTHROPIC_API_KEY`, still Anthropic
- [ ] `LLM_PROVIDER=deepseek` with no key throws an error naming `DEEPSEEK_API_KEY`
- [ ] Insufficient balance, rate limiting and an empty reply are each handled and distinguishable
- [ ] Tests mock `fetch` — **no test makes a live API call**, and no test contains a key
- [ ] `DEEPSEEK_API_KEY` appears in `.env.example` with an empty value and nowhere else in the repo
- [ ] The shared request/response code is shared, not duplicated from `openRouterProvider`

### Out of scope
Switching the production default to DeepSeek. This issue makes it available and proves it works; which provider the deployment actually uses is a separate call, and one the maintainer makes.

> **Drips Wave** · Complexity: **Intermediate** · **150 points**
