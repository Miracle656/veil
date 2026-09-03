#!/usr/bin/env node
/**
 * Synthetic uptime + freshness probe for the Veil backends.
 *
 * This is the alert half of docs/MONITORING.md. The outage that motivated it
 * (all three Render services returning 503) was found by a human clicking
 * around the wallet and noticing prices had gone blank. Nothing was watching.
 *
 * Two deliberate choices:
 *
 *   1. **It distinguishes failure modes rather than reporting "down".** A Render
 *      cold start, a suspended service, a crashed process and a healthy-but-
 *      stalled indexer need four different responses, and an alert that calls
 *      them all "down" trains you to ignore it. See classify() below.
 *
 *   2. **It checks freshness, not just reachability.** An indexer that answers
 *      200 while having ingested nothing for six hours is serving stale prices
 *      to a wallet, which is worse than being down: the UI shows a number and
 *      the number is wrong. A plain ping cannot see that.
 *
 * Usage:
 *   node scripts/uptime-probe.mjs              # probe, exit non-zero if unhealthy
 *   node scripts/uptime-probe.mjs --warn-only  # always exit 0 (report only)
 *   node scripts/uptime-probe.mjs --json       # machine-readable output
 *
 * Overrides (so this works against staging or a local stack):
 *   WRAITH_URL, LENS_URL, AGENT_URL, MAX_STALENESS_MINUTES, PROBE_TIMEOUT_MS
 */

const WRAITH = (process.env.WRAITH_URL ?? "https://wraith-0jo1.onrender.com").replace(/\/+$/, "");
const LENS = (process.env.LENS_URL ?? "https://lens-ldtu.onrender.com").replace(/\/+$/, "");
const AGENT = (process.env.AGENT_URL ?? "https://veil-agent.onrender.com").replace(/\/+$/, "");

/**
 * Render free-tier instances sleep and can take the better part of a minute to
 * wake. That is slow, not broken, so the timeout has to sit well above a cold
 * start or the probe reports a false outage every time a service has been idle.
 */
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 90_000);

/** Above this, a served response is treated as a cold start rather than steady state. */
const COLD_START_MS = 10_000;

/** How far behind an indexer may fall before it is degraded rather than healthy. */
const MAX_STALENESS_MIN = Number(process.env.MAX_STALENESS_MINUTES ?? 60);

const TARGETS = [
  {
    name: "wraith /healthz",
    url: `${WRAITH}/healthz`,
    critical: true,
  },
  {
    name: "wraith /status",
    url: `${WRAITH}/status`,
    critical: true,
    // Wraith computes its own verdict and its own ledger lag; trust them
    // rather than re-deriving a threshold here.
    inspect: (body) => {
      if (body?.status === "down") return { degraded: true, note: "reports status=down" };
      if (body?.status === "degraded") {
        return { degraded: true, note: `reports status=degraded${body.stale ? " (stale)" : ""}` };
      }
      if (typeof body?.lagLedgers === "number" && body.lagLedgers > 1000) {
        return { degraded: true, note: `ledger lag ${body.lagLedgers}` };
      }
      return { degraded: false, note: `lag ${body?.lagLedgers ?? "?"} ledgers` };
    },
  },
  {
    name: "lens /status",
    url: `${LENS}/status`,
    critical: true,
    inspect: (body) => {
      if (body?.ok !== true) return { degraded: true, note: "ok !== true" };
      const stale = minutesSince(body?.lastProcessedAt);
      if (stale === null) return { degraded: true, note: "no lastProcessedAt" };
      if (stale > MAX_STALENESS_MIN) {
        // Up, answering, and quietly serving prices from hours ago.
        return { degraded: true, note: `last ingest ${stale} min ago (limit ${MAX_STALENESS_MIN})` };
      }
      return { degraded: false, note: `last ingest ${stale} min ago` };
    },
  },
  {
    name: "lens /metrics",
    url: `${LENS}/metrics`,
    critical: false,
    // Prometheus exposition, not JSON. Its absence does not break the wallet,
    // but it does blind everything downstream of it.
    inspect: (_body, text) =>
      text?.includes("price_requests_total")
        ? { degraded: false, note: "exporting" }
        : { degraded: true, note: "no price_requests_total in output" },
  },
  {
    name: "agent /health",
    url: `${AGENT}/health`,
    critical: false,
  },
];

function minutesSince(timestamp) {
  if (!timestamp) return null;
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return null;
  return Math.round((Date.now() - then) / 60_000);
}

/**
 * Turn an HTTP outcome into one of five states.
 *
 * SUSPENDED is split out from DOWN on purpose. Render answers a suspended
 * service with `x-render-routing: suspend` and a 503 in well under a second —
 * whereas a sleeping instance hangs and then serves, and a crashed one usually
 * 502s. Suspension does not self-heal and no amount of retrying or pinging
 * fixes it, so it needs a person, not a restart. Conflating the two sends you
 * hunting through application logs for a billing or quota problem.
 */
function classify(res, elapsedMs) {
  if (res.status >= 200 && res.status < 300) {
    return elapsedMs > COLD_START_MS ? "UP_COLD" : "UP";
  }
  if (res.headers.get("x-render-routing") === "suspend") return "SUSPENDED";
  if (res.status >= 500) return "DOWN";
  return "ERROR";
}

async function probe(target) {
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "veil-uptime-probe" },
      redirect: "follow",
    });
    const elapsedMs = Date.now() - started;
    const state = classify(res, elapsedMs);

    if (state !== "UP" && state !== "UP_COLD") {
      return { ...target, state, elapsedMs, status: res.status, note: "" };
    }

    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* /metrics is Prometheus text, not JSON — inspect() receives the raw text */
    }

    const verdict = target.inspect ? target.inspect(body, text) : { degraded: false, note: "" };
    return {
      ...target,
      state: verdict.degraded ? "DEGRADED" : state,
      elapsedMs,
      status: res.status,
      note: verdict.note,
    };
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      ...target,
      state: timedOut ? "TIMEOUT" : "UNREACHABLE",
      elapsedMs,
      status: 0,
      note: timedOut ? `no response in ${TIMEOUT_MS} ms` : String(err?.message ?? err),
    };
  }
}

const HEALTHY = new Set(["UP", "UP_COLD"]);

const ICON = {
  UP: "OK  ",
  UP_COLD: "SLOW",
  DEGRADED: "WARN",
  SUSPENDED: "SUSP",
  DOWN: "DOWN",
  TIMEOUT: "TIME",
  UNREACHABLE: "GONE",
  ERROR: "ERR ",
};

/** What to actually do, printed next to the failure so the runbook is inline. */
const ACTION = {
  SUSPENDED:
    "Render service is suspended — check the Render dashboard for quota/billing. " +
    "Will NOT recover on its own; pinging it does not help.",
  DOWN: "5xx from the app or platform — check Render logs for a crash loop.",
  TIMEOUT: "No response within the timeout — cold start took too long, or the instance is wedged.",
  UNREACHABLE: "DNS or TLS failure — check the hostname is still correct.",
  DEGRADED: "Reachable but not serving good data — see the note; the wallet may be showing stale values.",
  ERROR: "Unexpected non-5xx failure status.",
  UP_COLD: "Served, but slowly — consistent with a free-tier cold start.",
};

async function main() {
  const warnOnly = process.argv.includes("--warn-only");
  const asJson = process.argv.includes("--json");

  const results = await Promise.all(TARGETS.map(probe));

  if (asJson) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
  } else {
    console.log(`Veil uptime probe — ${new Date().toISOString()}\n`);
    for (const r of results) {
      const ms = `${String(r.elapsedMs).padStart(6)} ms`;
      const http = r.status ? String(r.status) : "---";
      console.log(`  ${ICON[r.state]}  ${http}  ${ms}  ${r.name}${r.note ? `  — ${r.note}` : ""}`);
    }
  }

  const failing = results.filter((r) => !HEALTHY.has(r.state));
  const criticalFailing = failing.filter((r) => r.critical);

  if (failing.length && !asJson) {
    console.log("\nWhat to do:");
    for (const r of failing) {
      console.log(`  - ${r.name} [${r.state}]: ${ACTION[r.state] ?? "investigate"}`);
    }
  }

  if (!failing.length) {
    console.log("\nAll targets healthy.");
    return 0;
  }

  console.log(
    `\n${failing.length} target(s) unhealthy, ${criticalFailing.length} critical.`
  );

  // Only a critical target fails the run. The agent and the metrics endpoint
  // being down is worth reporting, but paging on it would train us to ignore
  // this check — and an alert people ignore is the same as no alert.
  if (warnOnly) return 0;
  return criticalFailing.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("probe crashed:", err);
    process.exit(1);
  });
