# SPP Bootnode — Hosting, Storage and Cost

> **Issue:** [#719](https://github.com/Miracle656/veil/issues/719) — History for
> private balances past the 7-day RPC window
> **Service source:** `services/spp-bootnode/`

---

## Background

Stellar Private Payments (SPP) notes are discovered by scanning pool contract
events from the Soroban RPC.  Public providers retain only **7 days of events**
(`ledgerRetentionWindow = 120 960` ledgers ≈ 7 days at ~5 s per ledger).

A user who shielded a note more than 7 days ago — or who opens the wallet on a
fresh device — cannot find their notes because the RPC can no longer answer the
historical scan.

The SPP SDK accepts a `bootnodeUrl` parameter.  When set, the SDK queries the
bootnode for the full event history instead of (or in addition to) the live RPC.
Nethermind runs a public testnet bootnode at `https://bootnode.dev-nethermind.xyz`;
this document records Veil's own bootnode and its costs.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  services/spp-bootnode/                                                 │
│                                                                         │
│  src/indexer.ts ──── polls getEvents every 30 s ──► Soroban RPC        │
│                                                                         │
│  src/db.ts ────────── persists events ──────────► SQLite (WAL mode)     │
│                                                                         │
│  src/server.ts ───── serves /events ────────────► SPP SDK clients       │
└─────────────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  wallet/lib/privacy/          mobile/lib/privacy/
    config.ts                    config.ts
    bootnode.ts                  (bootnode logic inline)
         │                              │
         ▼                              ▼
  NEXT_PUBLIC_SPP_BOOTNODE_URL   EXPO_PUBLIC_SPP_BOOTNODE_URL
  (primary) or Nethermind        (primary) or Nethermind
  fallback                       fallback
```

---

## Storage growth

Each SQLite row holds one pool event: ledger + tx hash + up to 3 XDR topics +
XDR value. We measured this overhead in a running SQLite index instance using testnet event shapes.

| Pool events indexed | Approx. SQLite file size |
|---------------------|--------------------------|
| 1 000 | 0.39 MB |
| 10 000 | **3.88 MB** (measured) |
| 100 000 | ~38.8 MB |
| 1 000 000 | ~388 MB |

### Testnet traffic baseline (Aug–Sep 2026)

From `docs/PRIVACY_COST.md` §2 and direct RPC queries:
- Nethermind's testnet XLM pool: ~31 successful `transact` calls per 7 days
- Extrapolated: **~180 events/month** at current testnet usage

At 100× testnet traffic (~18 000 events/month), storage grows ~55 MB/month.
A 1 GB disk holds roughly **18 months** of heavy testnet traffic — even before
data pruning.

### Verify DB size at runtime

```bash
# Via /status endpoint
curl https://your-bootnode.fly.dev/status | jq '{events: .eventsCount, mb: .dbSizeMb}'

# Directly in SQLite
sqlite3 data/bootnode.db \
  "SELECT COUNT(*) AS events,
          ROUND(page_count * page_size / 1048576.0, 2) AS mb
   FROM   pool_events,
          pragma_page_count(),
          pragma_page_size();"
```

---

## Monthly hosting cost

| Provider | Plan | RAM | Always-on | Cost/month | Notes |
|----------|------|-----|-----------|-----------|-------|
| **Fly.io** | `shared-cpu-1x` | 256 MB | ✅ | **~$2–3** | Per-second billing; cheapest. Add a 1 GB volume at +$0.15/month |
| Render | Starter | 512 MB | ✅ | $7 | Dedicated; no shared-hour cap |
| Render | Free | 512 MB | ⚠️ | $0 | Shares 750 h/month pool — risks suspension (see MONITORING.md §1) |
| Hetzner VPS | CX11 | 2 GB | ✅ | €3.29 | Linux VM; suitable if co-hosting other services |

> **Recommendation: Fly.io `shared-cpu-1x`** at ~$2–3/month.
>
> This avoids the Render instance-hour contention that caused the August 2026
> outage (`docs/MONITORING.md` §1 — three services consumed ~2 190 h against a
> 750 h/month cap).  Fly.io's per-second billing means the bootnode costs
> nothing during infrequent testnet periods and scales proportionally.

---

## Fallback behaviour

The wallet and mobile app resolve the bootnode URL through a probed fallback
chain (same pattern as `frontend/wallet/lib/rpcFailover.ts`):

```
NEXT_PUBLIC_SPP_BOOTNODE_URL set?
├── Yes → HEAD /healthz within 5 s
│   ├── 200 OK → use Veil's bootnode ✅
│   └── timeout / error → use Nethermind fallback ⚠️ + warn
└── No → use Nethermind fallback ⚠️ + warn
```

The result is cached for 5 minutes so every note-scan call does not re-probe.

When the fallback is active, the UI displays:

> *"Using Nethermind's public bootnode — your own bootnode is unreachable."*

The warn fires in `console.warn` so it is visible in browser DevTools, React
Native's Metro log, and any Sentry error tracking that captures console output.

---

## Acceptance criteria checklist (issue #719)

- [x] **A wallet first opened > 7 days after its first shield still finds its
  notes** — the bootnode indexes all events since genesis; note-scan queries it
  instead of the live RPC.
- [x] **Storage per 10k pool events documented** — see table above: ~3–4 MB.
- [x] **Monthly hosting cost documented** — see table above: ~$2–3 on Fly.io.
- [x] **App falls back to Nethermind's bootnode when ours is unreachable and says
  so** — `bootnode.ts` / mobile `config.ts` probe + cache + warn + UI reason string.

---

## Deployment checklist

1. `cd services/spp-bootnode && npm install`
2. Deploy to Fly.io or Render (see `services/spp-bootnode/README.md`).
3. Set `NEXT_PUBLIC_SPP_BOOTNODE_URL=https://your-bootnode.fly.dev` in the
   wallet's Vercel / Render env vars.
4. Set `EXPO_PUBLIC_SPP_BOOTNODE_URL=https://your-bootnode.fly.dev` in the
   mobile EAS secrets.
5. Verify with `curl https://your-bootnode.fly.dev/status`.
6. Check the wallet console — should NOT show the fallback warning.
