import { useEffect, useState, useCallback, useRef } from 'react';
import { AppState, type NativeEventSubscription } from 'react-native';

import { getNetwork } from './network';

// ── Types ───────────────────────────────────────────────────────────────────

export interface TxRecord {
  id: string;
  type: 'sent' | 'received' | 'swapped';
  amount: string;
  asset: string;
  counterparty: string;
  timestamp: number;
  hash?: string;
  memo?: string;
  // swap-specific
  destAmount?: string;
  destAsset?: string;
}

type ActivityListener = (records: TxRecord[]) => void;

/**
 * The indexer is reachable but does not index this network.
 *
 * Distinct from a failure on purpose. Wraith runs testnet only today; a mainnet
 * wallet asking it for transfers is not broken, it is asking a question this
 * deployment cannot answer, and the app already has Horizon for that. Logging
 * it as a failure every fifteen seconds teaches the user to distrust a working
 * app.
 */
export class IndexerNetworkUnsupported extends Error {
  readonly network: string;
  constructor(network: string) {
    super(`The indexer does not serve ${network}`);
    this.name = 'IndexerNetworkUnsupported';
    this.network = network;
  }
}

// ── Module-level store (survives component remounts) ────────────────────────

let _records: TxRecord[] = [];
let _listeners = new Set<ActivityListener>();
let _pollInterval: ReturnType<typeof setInterval> | null = null;
let _appStateSub: NativeEventSubscription | null = null;
let _currentAddress: string | null = null;
let _wraithUrl: string | null = null;
/** Reset whenever polling is re-armed, so a network switch can say its piece once. */
let _warnedUnsupported = false;

/** A request we cancelled ourselves, not a network that failed. */
function isAbort(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return err.name === 'AbortError' || err.name === 'TimeoutError';
  }
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError' || err.message === 'Aborted';
}

// Default polling interval: 15 seconds
const POLL_MS = 15_000;

function notify(): void {
  const snapshot = [..._records];
  for (const listener of _listeners) {
    listener(snapshot);
  }
}

// ── Wraith API helpers ──────────────────────────────────────────────────────

interface WraithTransfer {
  id: number;
  eventType: string;
  fromAddress: string | null;
  toAddress: string | null;
  amount: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  contractId: string;
}

interface WraithResponse {
  transfers: WraithTransfer[];
}

function wraithTransferToTxRecord(t: WraithTransfer, userAddress: string): TxRecord {
  const isSent =
    t.fromAddress !== null &&
    t.fromAddress.toUpperCase() === userAddress.toUpperCase();

  // Detect swap events from the Wraith eventType
  const isSwap =
    t.eventType === 'path_payment' ||
    t.eventType === 'path_payment_strict_send' ||
    t.eventType === 'path_payment_strict_receive';

  // Parse amount safely (fall back to '0' if missing or invalid)
  const rawAmount = t.amount ?? '0';
  const numericAmount = Number(rawAmount);
  const safeAmount = Number.isFinite(numericAmount) ? Math.abs(numericAmount) / 10_000_000 : 0;

  // Parse timestamp safely
  let timestamp = 0;
  if (t.ledgerClosedAt) {
    const ts = new Date(t.ledgerClosedAt).getTime();
    if (Number.isFinite(ts)) timestamp = Math.floor(ts / 1000);
  }

  if (isSwap) {
    return {
      id: `w-${t.id}`,
      type: 'swapped',
      amount: safeAmount.toFixed(7),
      asset: 'XLM',
      counterparty: isSent
        ? t.toAddress ?? 'unknown'
        : t.fromAddress ?? 'unknown',
      timestamp,
      hash: t.txHash,
      // Swap-specific fields (Wraith may not provide destAmount/destAsset)
      destAmount: safeAmount.toFixed(7),
      destAsset: 'XLM',
    };
  }

  return {
    id: `w-${t.id}`,
    type: isSent ? 'sent' : 'received',
    amount: safeAmount.toFixed(7),
    asset: 'XLM',
    counterparty: isSent
      ? t.toAddress ?? 'unknown'
      : t.fromAddress ?? 'unknown',
    timestamp,
    hash: t.txHash,
  };
}

/**
 * Fetch transfers for a given Stellar address from the Wraith indexer.
 *
 * Throws on network, HTTP or parse failure. Returning an empty array instead
 * would make "the indexer is unreachable" indistinguishable from "this wallet
 * has no transfers", and the caller needs to tell a user those apart.
 */
async function fetchTransfers(
  wraithUrl: string,
  address: string,
): Promise<TxRecord[]> {
  // /accounts/:address/transfers, not /transfers/:address. The path was
  // inverted, so every poll 404'd — invisible until EXPO_PUBLIC_WRAITH_URL was
  // set, because with no URL configured the fetch never ran at all.
  //
  // The network has to travel with the request. Without it the indexer answers
  // for its own default, so a mainnet wallet was being shown a testnet index —
  // an empty feed that looked like "no transfers" rather than "asked the wrong
  // chain", which is the only reason it went unnoticed. Asking for a network an
  // indexer does not serve is a deployment fact, not a fault: it is reported as
  // its own error so the caller can fall back to Horizon quietly.
  const network = getNetwork().name;
  const base = wraithUrl.replace(/\/+$/, '');
  const url = `${base}/accounts/${encodeURIComponent(address)}/transfers?limit=50&network=${network}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 400 || res.status === 404) {
    throw new IndexerNetworkUnsupported(network);
  }
  if (!res.ok) {
    throw new Error(`Wraith returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as WraithResponse;
  if (!data.transfers || !Array.isArray(data.transfers)) {
    throw new Error('Wraith returned an unexpected response shape');
  }

  return data.transfers.map((t) => wraithTransferToTxRecord(t, address));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Replace the store with a batch of pre-fetched records (e.g. initial load).
 * Notifies all subscribers.
 *
 * Pass `{ merge: true }` for a refresh. The feed is rebuilt from sources that
 * can each degrade independently — a rate-limited RPC event scan, a Horizon
 * page that times out — so a refresh that returns fewer rows usually means one
 * source blinked, not that history vanished. Replacing wholesale made the feed
 * visibly empty and refill every few polls; merging keeps the union, newest
 * first, with the incoming (fresher) version of a row winning on id collision.
 *
 * Wiping still has to be possible, so the default stays replace: switching
 * wallets must not leave the previous wallet's rows on screen.
 */
export function hydrateActivityFeed(records: TxRecord[], options?: { merge?: boolean }): void {
  if (!options?.merge) {
    _records = records;
    notify();
    return;
  }

  const byMovement = new Map<string, TxRecord>();
  for (const r of _records) byMovement.set(movementKey(r), r);
  // Incoming wins on collision: it is the fresher read of the same movement,
  // and may carry a richer version of it (a swap rather than a bare transfer).
  for (const r of records) byMovement.set(movementKey(r), r);
  _records = [...byMovement.values()].sort((a, b) => b.timestamp - a.timestamp);
  notify();
}

/**
 * Identity of a *movement of funds*, as distinct from identity of a row.
 *
 * A payment can reach this feed through two sources with two different ids:
 * the contract's SAC transfer event and the fee-payer's classic Horizon
 * payment. `loadHorizonActivity` reconciles them by hash within a single
 * fetch, but across polls the winning source can change — the classic leg is
 * indexed a moment later than the event — so the same payment arrives first as
 * `ev.id` and then as the Horizon operation id. Keyed by id, both survive and
 * the user sees their transfer twice.
 *
 * The hash alone is too coarse to key on: a bulk payout is one transaction
 * carrying many payments, and collapsing by hash would show one row instead of
 * five. Counterparty, amount and asset separate those, and are identical
 * across the two sources describing one movement.
 */
export function movementKey(r: TxRecord): string {
  if (!r.hash) return r.id;
  return `${r.hash}|${r.type}|${r.counterparty}|${r.amount}|${r.asset}`;
}

/**
 * Append new records, deduplicating by movement and sorting newest-first.
 * Notifies all subscribers.
 */
export function appendActivityFeed(newRecords: TxRecord[]): void {
  const present = new Set(_records.map(movementKey));
  const deduped = newRecords.filter((r) => !present.has(movementKey(r)));
  if (deduped.length === 0) return;
  _records = [..._records, ...deduped].sort((a, b) => b.timestamp - a.timestamp);
  notify();
}

/**
 * Subscribe to activity feed changes. Returns an unsubscribe function.
 * The listener is called immediately with the current snapshot.
 */
export function subscribeActivityFeed(listener: ActivityListener): () => void {
  _listeners.add(listener);
  listener([..._records]);
  return () => {
    _listeners.delete(listener);
  };
}

/**
 * Start polling the Wraith indexer for new transfers for the given address.
 * Pass `null` for `wraithUrl` to skip Wraith (fetch will be skipped).
 * Safe to call multiple times — only one poll loop runs at a time.
 */
export function startPolling(address: string, wraithUrl: string | null): void {
  if (
    _pollInterval &&
    _currentAddress === address &&
    _wraithUrl === wraithUrl
  ) {
    return; // already polling this address
  }

  stopPolling();
  _warnedUnsupported = false;
  _currentAddress = address;
  _wraithUrl = wraithUrl;

  if (!wraithUrl) return;

  const tick = async () => {
    try {
      const fresh = await fetchTransfers(wraithUrl, address);
      if (fresh.length > 0) {
        appendActivityFeed(fresh);
      }
    } catch (err) {
      // A poll failure is not the caller's problem to handle — it runs on a
      // timer with nobody awaiting it, so an unhandled rejection here becomes
      // a red box on the screen every few seconds while the feed itself is
      // perfectly usable from Horizon. The initial load still throws, because
      // there the caller CAN distinguish "unreachable" from "no transfers".
      //
      // Two things are not failures and must not be logged as such. A cancelled
      // request is the app's own doing (a reload, a teardown), and this line
      // printing "poll failed: Aborted" after every Fast Refresh reads as a
      // broken network. A network the indexer does not serve is a deployment
      // fact, true on every tick, and worth saying exactly once.
      if (isAbort(err)) return;
      if (err instanceof IndexerNetworkUnsupported) {
        if (!_warnedUnsupported) {
          _warnedUnsupported = true;
          console.info(`[activity] ${err.message} — using Horizon for this wallet.`);
        }
        return;
      }
      console.warn('[activity] poll failed:', err instanceof Error ? err.message : err);
    }
  };

  const start = () => {
    if (_pollInterval === null) _pollInterval = setInterval(() => void tick(), POLL_MS);
  };
  const stop = () => {
    if (_pollInterval !== null) {
      clearInterval(_pollInterval);
      _pollInterval = null;
    }
  };

  if (AppState.currentState === 'active') start();

  // Backgrounded, this stops. Nothing reads the feed behind a locked screen,
  // and every tick is an indexer request; a phone left in a pocket would
  // otherwise spend the hour making them.
  _appStateSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void tick();
      start();
    } else {
      stop();
    }
  });
}

/**
 * Stop the polling loop and clear the current address.
 */
export function stopPolling(): void {
  _appStateSub?.remove();
  _appStateSub = null;
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
  _currentAddress = null;
  _wraithUrl = null;
}

// ── React hook ──────────────────────────────────────────────────────────────

/**
 * React hook that subscribes to the activity feed store.
 * Returns the current list of records, updating whenever the store changes.
 */
export function useActivityFeed(): TxRecord[] {
  const [records, setRecords] = useState<TxRecord[]>(() => [..._records]);

  useEffect(() => {
    return subscribeActivityFeed(setRecords);
  }, []);

  return records;
}

/**
 * React hook that fetches the initial activity feed from Wraith, hydrates the
 * store, starts polling for live updates, and cleans up on unmount.
 *
 * @param address - The Stellar address (C... or G...) to fetch transfers for.
 * @param wraithUrl - The base URL of the Wraith indexer (e.g. from env).
 */
export function useInitActivityFeed(
  address: string | null,
  wraithUrl: string | null,
): { loading: boolean; error: string | null; refresh: () => Promise<void> } {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initiatedRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    if (!wraithUrl) {
      setLoading(false);
      return;
    }

    try {
      const records = await fetchTransfers(wraithUrl, address);
      if (records.length > 0) {
        // Merge with any existing records, dedup by hash
        const merged = [...records, ..._records]
          .filter(
            (tx, i, arr) =>
              arr.findIndex(
                (t) => t.hash === tx.hash && t.hash !== undefined,
              ) === i,
          )
          .sort((a, b) => b.timestamp - a.timestamp);
        hydrateActivityFeed(merged);
      }
      setError(null);
    } catch (err) {
      // An indexer that does not serve this network is not an error the user
      // can act on, and the dashboard loads the same history from Horizon
      // anyway. Surfacing it would put a red banner over a screen that is
      // about to fill with correct data.
      if (err instanceof IndexerNetworkUnsupported || isAbort(err)) {
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load activity');
      }
    } finally {
      setLoading(false);
    }
  }, [address, wraithUrl]);

  useEffect(() => {
    if (!address) return;

    // Only run initial load once per address
    if (initiatedRef.current === address) return;
    initiatedRef.current = address;

    setLoading(true);
    load();

    startPolling(address, wraithUrl);

    return () => {
      // Don't stop polling on unmount — keep feed alive for other screens.
      // stopPolling() is called explicitly when the user switches accounts.
    };
  }, [address, wraithUrl, load]);

  return { loading, error, refresh: load };
}