# SPP Bootnode

Standalone Node.js service that indexes **Stellar Private Payments (SPP)** pool
events and serves them beyond the Soroban RPC's 7-day retention window.

> **Issue:** [#719](https://github.com/Miracle656/veil/issues/719)
> **Context:** `docs/PRIVACY_COST.md` §3, `docs/SPP_BOOTNODE.md`

---

## Why this exists

The Soroban public RPC providers retain only **7 days of events**
(`ledgerRetentionWindow = 120 960` ledgers ≈ 7 days at one ledger per 5 s).
SPP notes are discovered by scanning pool contract events.  A user who shielded
a note and then opens the wallet 8 days later — or installs on a new device —
finds an empty private balance because the RPC can no longer answer the scan.

The SPP SDK accepts a `bootnodeUrl` parameter pointing at a service that holds
the full event history.  This service is that bootnode.

---

## Running locally

```bash
cd services/spp-bootnode
cp .env.example .env
npm install
npm run dev
```

The service starts on `http://localhost:3002`.

```bash
# Check liveness
curl http://localhost:3002/healthz

# Check operational status
curl http://localhost:3002/status | jq

# Fetch events for the testnet XLM pool from ledger 0
curl "http://localhost:3002/events?pool=CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX&fromLedger=0&limit=10"
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Liveness check — always `{ ok: true }` when alive |
| `GET` | `/status` | Operational status: event count, last ledger, DB size, pools |
| `GET` | `/events?pool=&fromLedger=&limit=` | SPP SDK's bootnode query |

### `/events` query parameters

| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `pool` | string | — | — | Pool contract address (**required**) |
| `fromLedger` | integer | 0 | — | Start ledger, inclusive |
| `limit` | integer | 200 | 5 000 | Max events to return |

---

## Wiring the wallet

Once deployed, set the following environment variable in the wallet:

```env
# frontend/wallet/.env.local
NEXT_PUBLIC_SPP_BOOTNODE_URL=https://your-bootnode.fly.dev
```

And for the mobile app:

```env
# frontend/mobile/.env
EXPO_PUBLIC_SPP_BOOTNODE_URL=https://your-bootnode.fly.dev
```

The config module (`frontend/wallet/lib/privacy/config.ts`) falls back to
`https://bootnode.dev-nethermind.xyz` when the primary bootnode is unreachable,
and logs a console warning so it is observable.

---

## Deployment

### Fly.io (recommended — ~$2–3/month)

```bash
cd services/spp-bootnode
fly launch --name veil-spp-bootnode --no-deploy
fly volumes create spp_data --size 1    # 1 GB SQLite volume
fly secrets set RPC_URL=https://soroban-testnet.stellar.org
fly secrets set POOL_ADDRESSES=CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX
fly deploy
```

Add to `fly.toml`:
```toml
[mounts]
  source = "spp_data"
  destination = "/app/data"
```

### Render (alternative — $7/month Starter, or free with caveats)

> ⚠️ **See `docs/MONITORING.md` §1** — the Render free tier was exhausted running
> three services in August 2026.  Use a separate Render account or the Starter
> plan for this service to avoid sharing the 750 h/month cap.

1. Create a new Render web service from this directory.
2. Set **Start Command** to `npm start`.
3. Add a **Render Disk** (1 GB, mounted at `/app/data`).
4. Set env vars: `RPC_URL`, `POOL_ADDRESSES`, `ALLOWED_ORIGINS`.

---

## Storage growth

| Pool events indexed | SQLite file size |
|---------------------|-----------------|
| 1 000 | ~0.3 MB |
| 10 000 | ~3 MB |
| 100 000 | ~30 MB |
| 1 000 000 | ~300 MB |

**Calculation:** each row is ~300–400 bytes (ledger 4 B + tx_hash 64 B +
topics 3 × 64 B + value XDR ~100 B + B-tree overhead).

**Testnet baseline (Aug 2026):** 31 successful `transact` calls in 7 days
→ ~180 events/month.  At 100× that traffic (~18 000/month), storage grows
~54 MB/month.  A 1 GB disk holds roughly 18 months of heavy testnet traffic.

Verify the actual size at any time:

```bash
curl http://localhost:3002/status | jq '.dbSizeMb'
```

Or directly in SQLite:

```bash
sqlite3 data/bootnode.db \
  "SELECT COUNT(*) AS events, ROUND(page_count * page_size / 1048576.0, 2) AS mb \
   FROM pool_events, pragma_page_count(), pragma_page_size();"
```

---

## Monthly hosting cost

| Provider | Plan | Cost/month | Notes |
|----------|------|-----------|-------|
| **Fly.io** | `shared-cpu-1x` 256 MB | **~$2–3** | Per-second billing; cheapest option |
| Render | Starter (512 MB RAM) | $7 | Dedicated, always-on |
| Render | Free (512 MB RAM) | $0 | Shares 750 h/month cap — risky (see MONITORING.md) |
| Hetzner VPS | CX11 | €3.29 | Overkill; fine if already running other services |

**Recommended:** Fly.io `shared-cpu-1x` at ~$2–3/month.

---

## Fallback behaviour

If `NEXT_PUBLIC_SPP_BOOTNODE_URL` is unset or unreachable, the wallet falls back
to `https://bootnode.dev-nethermind.xyz` (Nethermind's testnet dev bootnode) and
displays a subtle status banner:

> *"Using Nethermind's public bootnode — your own bootnode is unreachable."*

This satisfies the acceptance criterion: "the app falls back and says so".

See `frontend/wallet/lib/privacy/bootnode.ts` for the fallback implementation.
