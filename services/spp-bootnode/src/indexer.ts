/**
 * SPP event indexer — core polling loop for the bootnode service (#719).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Reads the last indexed ledger from SQLite on startup (checkpoint).
 * 2. Calls `getEvents` on the Soroban RPC for each configured pool, paging
 *    through all events since the checkpoint in batches of 200.
 * 3. Writes new events to SQLite and advances the checkpoint.
 * 4. Sleeps for `POLL_INTERVAL_MS` and repeats.
 *
 * WHY POLLING (NOT STREAMING)
 * ─────────────────────────────────────────────────────────────────────────────
 * The Soroban RPC exposes `getEvents` as a request/response JSON-RPC call,
 * not a streaming subscription.  The existing codebase already shims out
 * `eventsource` (metro.config.js) because `.stream()` is unavailable in some
 * environments.  Polling every 30 s is simpler, robust to reconnect, and
 * sufficient: a Stellar ledger closes every ~5 s, so 30 s introduces at most
 * 6 ledgers of lag (~30 s), which is fine for note discovery.
 *
 * TESTNET POOL ADDRESSES (defaults)
 * ─────────────────────────────────────────────────────────────────────────────
 * From docs/PRIVACY_COST.md §2 and NethermindEth/stellar-private-payments
 * deployments/testnet:
 *   XLM pool:  CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX
 *
 * Override via POOL_ADDRESSES env var (comma-separated).
 */

import type Database from 'better-sqlite3';
import {
  SorobanRpc,
  xdr,
} from '@stellar/stellar-sdk';
import {
  countEvents,
  getCheckpoint,
  insertEvents,
  setCheckpoint,
  type PoolEvent,
} from './db.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_PAGE_SIZE = 200; // Soroban RPC max per getEvents call
const DEFAULT_POOL_ADDRESSES = [
  'CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX',
];

export interface IndexerConfig {
  rpcUrl: string;
  networkPassphrase: string;
  poolAddresses: string[];
  pollIntervalMs: number;
  pageSize: number;
}

export function indexerConfigFromEnv(): IndexerConfig {
  const rpcUrl =
    process.env['RPC_URL']?.trim() || 'https://soroban-testnet.stellar.org';
  const networkPassphrase =
    process.env['NETWORK_PASSPHRASE']?.trim() ||
    'Test SDF Network ; September 2015';
  const poolAddresses = (
    process.env['POOL_ADDRESSES']?.trim() || DEFAULT_POOL_ADDRESSES.join(',')
  )
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const pollIntervalMs =
    parseInt(process.env['POLL_INTERVAL_MS'] ?? '', 10) ||
    DEFAULT_POLL_INTERVAL_MS;
  const pageSize =
    parseInt(process.env['PAGE_SIZE'] ?? '', 10) || DEFAULT_PAGE_SIZE;

  return { rpcUrl, networkPassphrase, poolAddresses, pollIntervalMs, pageSize };
}

// ---------------------------------------------------------------------------
// Indexer state (exported so /status can read it)
// ---------------------------------------------------------------------------

export interface IndexerStatus {
  lastIndexedLedger: number;
  eventsCount: number;
  pools: string[];
  pollIntervalMs: number;
  running: boolean;
  lastPollAt: string | null;
  lastError: string | null;
}

let _status: IndexerStatus = {
  lastIndexedLedger: 0,
  eventsCount: 0,
  pools: [],
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  running: false,
  lastPollAt: null,
  lastError: null,
};

export function getIndexerStatus(): IndexerStatus {
  return { ..._status };
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all events for `contractId` from `fromLedger` onwards, paging through
 * results until the RPC returns fewer than `pageSize` records (end of history).
 *
 * Returns the events and the highest ledger seen, or `null` if no events exist.
 */
async function fetchAllEventsForPool(
  server: SorobanRpc.Server,
  contractId: string,
  fromLedger: number,
  pageSize: number,
): Promise<{ events: PoolEvent[]; highestLedger: number } | null> {
  const allEvents: PoolEvent[] = [];
  let cursor: string | undefined = undefined;
  let highestLedger = fromLedger;
  let page = 0;

  while (true) {
    page++;
    let response: SorobanRpc.Api.GetEventsResponse;

    try {
      response = await server.getEvents({
        startLedger: fromLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [contractId],
          },
        ],
        cursor,
        limit: pageSize,
      });
    } catch (err) {
      console.error(
        `[indexer] getEvents failed for pool ${contractId} page ${page}:`,
        (err as Error).message,
      );
      // Return whatever we managed to collect so far rather than losing it.
      break;
    }

    if (response.events.length === 0) break;

    for (const ev of response.events) {
      const topics = ev.topic;
      const poolEvent: PoolEvent = {
        ledger: ev.ledger,
        txHash: ev.txHash,
        eventIdx: ev.id ? parseInt(ev.id.split('-')[1] ?? '0', 10) : 0,
        pool: contractId,
        topic0: topics[0] ? topics[0].toXDR('base64') : '',
        topic1: topics[1] ? topics[1].toXDR('base64') : null,
        topic2: topics[2] ? topics[2].toXDR('base64') : null,
        valueXdr: ev.value.toXDR('base64'),
      };
      allEvents.push(poolEvent);
      if (ev.ledger > highestLedger) highestLedger = ev.ledger;
    }

    // If we got fewer than pageSize events, we've reached the end.
    if (response.events.length < pageSize) break;

    // Advance cursor for the next page.
    const lastEvent = response.events[response.events.length - 1];
    cursor = lastEvent?.id;
    if (!cursor) break;
  }

  if (allEvents.length === 0) return null;
  return { events: allEvents, highestLedger };
}

// ---------------------------------------------------------------------------
// Main poll cycle
// ---------------------------------------------------------------------------

async function pollOnce(
  db: Database.Database,
  server: SorobanRpc.Server,
  config: IndexerConfig,
): Promise<void> {
  const fromLedger = getCheckpoint(db);
  let newHighest = fromLedger;
  let totalNewEvents = 0;

  for (const pool of config.poolAddresses) {
    const result = await fetchAllEventsForPool(
      server,
      pool,
      // Start one ledger past the checkpoint so we don't re-fetch the last
      // already-indexed ledger.  On a fresh DB (fromLedger=0) start from 1.
      Math.max(fromLedger + 1, 1),
      config.pageSize,
    );

    if (!result) continue;

    const inserted = insertEvents(db, result.events);
    totalNewEvents += inserted;
    if (result.highestLedger > newHighest) {
      newHighest = result.highestLedger;
    }

    console.log(
      `[indexer] pool ${pool.slice(0, 8)}… +${inserted} new events` +
        ` (${result.events.length} fetched, ledgers ${fromLedger + 1}–${result.highestLedger})`,
    );
  }

  if (newHighest > fromLedger) {
    setCheckpoint(db, newHighest);
  }

  _status.lastIndexedLedger = newHighest;
  _status.eventsCount = countEvents(db);
  _status.lastPollAt = new Date().toISOString();

  if (totalNewEvents > 0) {
    console.log(`[indexer] poll complete: +${totalNewEvents} events, checkpoint=${newHighest}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the indexer.  Returns a stop function that resolves when the current
 * poll cycle completes.
 *
 * @param db     - Open SQLite database from `openDb()`.
 * @param config - Resolved configuration from `indexerConfigFromEnv()`.
 */
export function startIndexer(
  db: Database.Database,
  config: IndexerConfig,
): { stop: () => Promise<void> } {
  const server = new SorobanRpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith('http://'),
  });

  _status.pools = config.poolAddresses;
  _status.pollIntervalMs = config.pollIntervalMs;
  _status.running = true;
  _status.lastIndexedLedger = getCheckpoint(db);

  let stopped = false;
  let stopResolve: () => void;
  const stopPromise = new Promise<void>((res) => {
    stopResolve = res;
  });

  // Run the first poll immediately, then on the configured interval.
  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await pollOnce(db, server, config);
        _status.lastError = null;
      } catch (err) {
        const msg = (err as Error).message;
        _status.lastError = msg;
        console.error('[indexer] unexpected error:', msg);
      }

      if (stopped) break;

      // Sleep for pollIntervalMs, but wake immediately if stop() is called.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, config.pollIntervalMs);
        // Allow early exit from the sleep on stop.
        stopPromise.then(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }

    _status.running = false;
    stopResolve!();
  }

  void loop();

  return {
    stop: (): Promise<void> => {
      stopped = true;
      return stopPromise;
    },
  };
}
