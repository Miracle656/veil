# Expo Push API Sender (`push-sender`)

Authoritative backend service for sending push notifications via Expo Push API with batching, scheduled receipt polling, token pruning, rate limiting, and dry-run previewing (GitHub issue [#1275](https://github.com/Miracle656/veil/issues/1275)).

---

## Features

1. **Automatic Batching & Project Grouping**
   - Outbound notifications are grouped by `projectId` first.
   - Each project's messages are chunked into batches of at most **100 notifications per HTTP request**.
   - Messages from different projects are never mixed in a single HTTP request.
2. **Payload Size Guard (4 KiB)**
   - Pre-validates UTF-8 byte length (`Buffer.byteLength(JSON.stringify(payload), 'utf8')`).
   - Payloads exceeding **4,096 bytes** fail with `MessageTooBig` before any network or rate limiter call.
3. **Per-Project Rate Limiting**
   - Enforces Expo's **600 notifications per second per project** rate limit using a sliding window.
4. **Resilient Retry & Backoff**
   - Retries transient network failures, HTTP `429`, HTTP `5xx`, and Expo `TOO_MANY_REQUESTS` / `MessageRateExceeded`.
   - Never retries non-429 client errors (HTTP `400`, `401`, etc.), failing immediately with typed `NonRetryableExpoError`.
5. **Scheduled Receipt Lifecycle & Token Pruning**
   - Tickets are persisted with `readyAt = sentAt + 15min` and `expiresAt = sentAt + 24h`.
   - The cancellable scheduler polls due receipts in batches of up to **1,000 IDs** per request.
   - Receipts reporting `DeviceNotRegistered` automatically **prune (delete) the token** from storage.
   - Receipts reporting `MessageRateExceeded` are rescheduled with exponential backoff.
   - Silent FCM credential failures (e.g. `InvalidCredentials`) are captured in structured delivery diagnostics and logged prominently as redacted warnings.
6. **Dry-Run Mode**
   - Available via CLI `--dry-run` or API `{ "dryRun": true }`.
   - Validates all message payloads, groups by project, computes batch splits, and formats the delivery plan without performing any HTTP requests or ticket writes.
7. **Secure Admin API**
   - Constant-time token verification (`crypto.timingSafeEqual`) on `/admin/*` routes.
   - Requires `Authorization: Bearer <PUSH_ADMIN_TOKEN>` or `x-admin-token`.
   - Fails closed with HTTP `503` if `PUSH_ADMIN_TOKEN` is unset.
   - Public `/healthz` liveness check.

---

## Expo Push Security (`EXPO_ACCESS_TOKEN`)

By default, any caller with an Expo push token can send notifications through Expo's public API. To prevent unauthorized notification spoofing:

1. Enable **Push Security** in your Expo/EAS dashboard (Settings → Push Notifications → Require Access Token).
2. Generate an Expo Access Token.
3. Configure `EXPO_ACCESS_TOKEN=<token>` in `.env`.
4. The service will automatically attach `Authorization: Bearer <EXPO_ACCESS_TOKEN>` to all outbound requests to `https://exp.host/--/api/v2/push/*`.

---

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3003` | HTTP server port |
| `PUSH_ADMIN_TOKEN` | Yes | — | Secret bearer token protecting all `/admin/*` routes |
| `EXPO_ACCESS_TOKEN` | No | — | EAS Access Token for Expo Push Security |
| `PUSH_STORE_PATH` | No | `./data/push-store.json` | Path to atomic JSON store |
| `RECEIPT_POLL_INTERVAL_MS` | No | `60000` | Receipt poll interval (ms) |

---

## CLI Usage

Run CLI commands via npm:

```bash
# Preview what would be sent without making any network calls
npm --prefix services/push-sender run cli -- send \
  --title "Payment Received" \
  --body "You received 25 USDC" \
  --project "default" \
  --token "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" \
  --dry-run

# Live send to specific tokens
npm --prefix services/push-sender run cli -- send \
  --title "Payment Received" \
  --body "You received 25 USDC" \
  --token "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"

# Poll receipts and prune unregistered tokens immediately
npm --prefix services/push-sender run cli -- poll-receipts --once
```

---

## API Endpoints

### Public
* `GET /healthz`: Process liveness check (`{ "status": "ok" }`).

### Admin (Requires `Authorization: Bearer <PUSH_ADMIN_TOKEN>`)
* `POST /admin/push/send`:
  ```json
  {
    "title": "Payment Received",
    "body": "You received 50 USDC",
    "tokens": ["ExponentPushToken[...]", "ExponentPushToken[...]"],
    "dryRun": false
  }
  ```
* `POST /admin/push/poll-receipts`: Triggers a manual poll cycle.
* `GET /admin/push/status`: Returns current scheduler and store metrics.
* `POST /admin/push/tokens`: Registers or updates a device push token (`{ "token": "...", "projectId": "..." }`).
* `DELETE /admin/push/tokens/:token`: Manually removes a device token.
