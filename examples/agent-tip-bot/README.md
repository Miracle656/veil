# Veil AI Tipping Agent

An autonomous agent that scores creator posts and tips the best ones with XLM — powered by Claude via [`@veil/agent`](../../packages/agent) tool-calling.

## How it works

```
fetch_posts → score_post (×N) → pay (for each score ≥ threshold)
```

The agent runs a single agentic loop with three tools:

| Tool | What it does |
|---|---|
| `fetch_posts` | Returns creator posts with engagement metrics |
| `score_post` | Scores a post 0–100 (engagement + length + originality) |
| `pay` | Sends an XLM tip via the session key; enforces the spend cap |

### Session key and spend cap

The bot signs payments with a **session key** — a plain Stellar keypair stored in `SESSION_KEY_SECRET`. Because it is pre-funded and its authority is scoped to the configured `SPEND_CAP_XLM` budget tracked per run, no passkey or human interaction is needed. This mirrors how a smart-wallet `approve()` allowance works: the key can spend up to the cap, then stops.

Scoring breakdown (0–100):

- **Engagement (50 pts)** — weighted likes + 3×reposts + 2×replies
- **Content length (30 pts)** — rewards substantive posts (>100 chars)
- **Originality (20 pts)** — technical keywords and open-source signals

## Setup

```bash
# 1. Build the agent package
cd ../../packages/agent && npm install && npm run build

# 2. Install example deps
cd ../../examples/agent-tip-bot
npm install

# 3. Configure
cp .env.example .env
# Edit .env: add ANTHROPIC_API_KEY and SESSION_KEY_SECRET
```

Fund the session key on testnet:
```
https://laboratory.stellar.org/#account-creator?network=test
```

## Run

```bash
npm start
```

Example output:

```
=== Veil AI Tipping Agent ===
Spend cap: 10 XLM | Threshold: 70/100 | Tip: 1 XLM
Session key: GABCDE...

→ fetch_posts({})
→ score_post({"post_id":"post-001"})
  Score: 78/100 (engagement 28/50, length 28/30, originality 20/20)
→ pay({"to_address":"GDQP2...","amount_xlm":1,"memo":"Great post! #veil-tip"})
  ✓ Tipped 1 XLM → GDQP2... (tx: abc123...)
→ score_post({"post_id":"post-002"})
  Score: 3/100 (engagement 0/50, length 3/30, originality 0/20)
...

=== Summary ===
Evaluated 5 posts. Tipped 3 creators (3 XLM total). 2 posts below threshold (70).

Total XLM spent: 3.00 / 10 XLM
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. Your Anthropic API key. |
| `SESSION_KEY_SECRET` | — | Required. Stellar secret for the session key. |
| `SPEND_CAP_XLM` | `10` | Max XLM to spend per run. |
| `SCORE_THRESHOLD` | `70` | Min score to trigger a tip (0–100). |
| `TIP_AMOUNT_XLM` | `1` | XLM amount per tip. |
| `STELLAR_NETWORK` | `testnet` | `testnet` or `mainnet`. |
| `HORIZON_URL` | testnet | Override Horizon endpoint. |

## Extending

- **Real post source** — replace `fetchPosts()` in `src/posts.ts` with a live API (X/Twitter, Farcaster Hub, Lens, RSS).
- **Smarter scoring** — pass post content to Claude inside `score_post` for semantic quality judgment.
- **Smart wallet** — wire `pay()` through `wallet.sendPayment()` from `invisible-wallet-sdk` to tip from a Soroban smart wallet instead of a classic account.
- **Scheduled runs** — wrap in a cron job or Vercel Cron to tip automatically on a schedule.
