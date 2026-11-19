# Recurring Airtime & Data Top-up — Buildathon Showcase Demo (Mainnet)

This runbook walks through the Stellar Buildathon Showcase demo: **"top up my line every week"**, paid by the Veil assistant from a small, contract-enforced allowance without the user present, with the deployed wallet contract refusing anything above that allowance.

## Mainnet Contract Facts

- Every Veil wallet on mainnet runs the InvisibleWallet WASM whose SHA-256 is:
  `b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5`
- Source commit: `ccebd01a9b71c9857e6cd1e05dbdf6d45ea38ba2`
- Mainnet USDC Stellar Asset Contract (SAC) ID:
  `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
- On this deployed contract, allowances are stored at persistent ledger key `DataKey::Allowance(AllowanceKey { spender, token })` as `Allowance { amount: i128, expiry: Option<u64> }`, enforced in `__check_auth` Branch 1 with a 60-second clock-skew tolerance (`CLOCK_SKEW_TOLERANCE_SECS = 60`). There is no upgrade or delete entry point; stopping an allowance replaces it with `amount = 1`, `expiry = 1`.

## Prerequisites

1. **Mainnet Veil wallet** with a small USDC balance (for example, `1.00 USDC` on the wallet contract) and a funded fee-payer account.
2. **Naira verification completed on-screen**: The wallet's `customerRef` must already be NIN-verified via the Verification screen (`/verify`). **Never enter or paste a NIN in chat, tool arguments, or logs.**
3. **Server environment**:
   - `WRAITH_URL` / `NEXT_PUBLIC_WRAITH_URL` pointing to the mainnet-capable wraith backend.
   - `NEXT_PUBLIC_ASSISTANT_SPENDER_ADDRESS` set to the full Stellar address of the assistant spender configured in `#1339`.
   - `RECURRING_PLANS_FILE` set to a persistent file path so plans and per-period idempotency records survive server restarts.
   - Optional `RECURRING_CRON_TOKEN` protecting `POST /api/recurring-topups/run` (or `AGENT_ACCESS_TOKEN` protecting `POST /recurring-topups/tick` on the standalone agent server).

---

## Step-by-Step Demo

### Step 1 — Grant a Small, Capped Allowance (`#1340`)

1. Open **Settings → Spending permissions** (`/settings/allowances`).
2. Grant the assistant spender an allowance on mainnet USDC (`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`) for a small cap — for example, **0.50 USDC** (`5000000` base units, enough for roughly two ₦200 top-ups) with a 30-day expiry.
3. Confirm with your passkey. Verify the allowance appears as **ACTIVE** on `/settings/allowances` with its full spender address, full token contract ID, remaining amount, and expiry.

### Step 2 — Set Up the Repeating Top-up in Chat

1. Open the **Assistant** (`/agent`).
2. Ask in plain English:
   > "Top up my MTN line `0803XXXXXXX` with 200 naira of airtime every week for 4 weeks using USDC."
3. The assistant calls `prepare_recurring_topup` and displays the **Repeating top-up plan** review card:
   - Provider & category (`MTN airtime`)
   - Amount (`₦200`), frequency (`weekly`), duration (`4` periods)
   - Masked phone number (`*******XXXX`) — raw phone number is kept out of logs and public views
4. Click **Confirm plan** once.
   - The server stores the plan via `POST /api/recurring-topups` and returns its `plan_...` ID.
   - Confirm that the plan appears under **Recurring top-up plans** on `/settings/allowances`.

### Step 3 — Automatic Execution of Period 1 (No User Present)

1. Trigger the due-period runner (or wait for the scheduled tick):
   ```bash
   curl -X POST https://<wallet-host>/api/recurring-topups/run \
     -H "Authorization: Bearer <RECURRING_CRON_TOKEN>"
   ```
2. The server:
   - Fetches the live NGN/USDC rate from wraith (`GET /ngn/onramp/rate?coin=usdc`, `x-network: mainnet`).
   - Checks the on-chain allowance at `DataKey::Allowance(AllowanceKey { spender, token })` before creating any order.
   - Creates the bill order through wraith (`POST /ngn/bills`) using the deterministic idempotency key `recurring_topup:<planId>:period:0`.
   - Persists the reserved order before paying, then pays the exact locked 7-decimal USDC amount from the allowance (`#1339`).
   - Records the full 64-character Stellar transaction hash and advances `nextDueAt` by 1 week.
3. **Verify retry & restart idempotency**:
   - Call `POST /api/recurring-topups/run` again immediately (or restart the server and call it again).
   - Confirm `outcomes` is `[]` — no second order and no second payment are created for Period 1.

### Step 4 — Verify Full Transaction Hash in Activity

1. Open **Activity** (`/activity`).
2. Locate the recurring top-up entry (`Recurring MTN airtime (₦200)`).
3. Tap the entry to open **Transaction Details** and confirm:
   - The **Tx Hash** is displayed **in full** (all 64 hex characters, never truncated).
   - Clicking the hash opens the transaction on Stellar Expert (mainnet), confirming the USDC transfer from the wallet contract to the wraith deposit address and the debited on-chain allowance.
4. Confirm airtime delivery on the recipient mobile line.

### Step 5 — Demonstrate Contract-Enforced Allowance Cap & Clean Stop

1. Either let earlier periods exhaust the 0.50 USDC allowance, **or** open **Settings → Spending permissions** (`/settings/allowances`) and click **Stop it now** on the assistant's allowance (which sets `amount = 1`, `expiry = 1` on chain).
2. Trigger the next due period (`POST /api/recurring-topups/run`).
3. Confirm:
   - **Nothing is submitted** to wraith or Stellar.
   - The plan moves to status **STOPPED** with `nextDueAt: null` (it will not retry).
   - Both in chat (`"Show my recurring top-up plans"`) and on `/settings/allowances`, the user sees:
     - Why it stopped (used up, expired, revoked/stopped, or insufficient remaining allowance),
     - What was paid (count, NGN total, and full 64-character transaction hashes), and
     - What was not paid (remaining periods and NGN total).

### Step 6 — List and Cancel a Plan

1. **In chat**: Ask `"List my recurring top-ups"`, then `"Cancel plan <plan_id>"` and click **Cancel plan** on the confirmation card.
2. **From the Allowance screen**: Open `/settings/allowances`, scroll to **Recurring top-up plans**, and click **Cancel plan** on any active plan.
3. Confirm the plan status changes to **CANCELLED** and future ticks skip it.

---

## Maintainer Mainnet Run Log

Complete this section once the Showcase demo has been executed on mainnet with a small amount:

- **Date (UTC)**: _pending maintainer mainnet run_
- **Wallet Contract ID (full)**: _pending_
- **Assistant Spender Address (full)**: _pending_
- **USDC SAC Contract ID (full)**: `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
- **Plan ID**: _pending_
- **Period 1 Amount**: `₦200`
- **Period 1 Transaction Hash (full 64 hex chars)**: _pending_
- **Observed Outcome**: _pending_
