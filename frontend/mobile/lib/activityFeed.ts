import { useEffect, useState, useCallback, useRef } from 'react';

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

// ── Module-level store (survives component remounts) ────────────────────────

let _records: TxRecord[] = [];
let _listeners = new Set<ActivityListener>();
let _pollInterval: ReturnType<typeof setInterval> | null = null;
let _currentAddress: string | null = null;
let _wraithUrl: string | null = null;

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
  const url = `${wraithUrl.replace(/\/+$/, '')}/transfers/${encodeURIComponent(address)}?limit=50`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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
 */
export function hydrateActivityFeed(records: TxRecord[]): void {
  _records = records;
  notify();
}

/**
 * Append new records, deduplicating by tx hash and sorting newest-first.
 * Notifies all subscribers.
 */
export function appendActivityFeed(newRecords: TxRecord[]): void {
  const deduped = newRecords.filter(
    (r) => !_records.some((existing) => existing.hash === r.hash && existing.hash !== undefined),
  );
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
  _currentAddress = address;
  _wraithUrl = wraithUrl;

  if (!wraithUrl) return;

  // Poll on an interval
  _pollInterval = setInterval(async () => {
    const fresh = await fetchTransfers(wraithUrl, address);
    if (fresh.length > 0) {
      appendActivityFeed(fresh);
    }
  }, POLL_MS);
}

/**
 * Stop the polling loop and clear the current address.
 */
export function stopPolling(): void {
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
): { loading: boolean; error: string | null } {
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
      setError(err instanceof Error ? err.message : 'Failed to load activity');
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

  return { loading, error };
}