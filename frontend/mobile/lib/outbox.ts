/**
 * AsyncStorage-backed offline transaction outbox with auto-replay on reconnect.
 *
 * Port of sdk/src/outbox.ts adapted for React Native:
 *   - Persistence via @react-native-async-storage/async-storage
 *   - Auto-replay via @react-native-community/netinfo connectivity listener
 *
 * A signed transaction is recorded *before* it is sent, then replayed
 * automatically once the device comes back online. Duplicate submission
 * is prevented by transaction-hash dedup and sequence-number uniqueness.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import {
  rpc as SorobanRpc,
  TransactionBuilder,
  type Transaction,
  type FeeBumpTransaction,
} from '@stellar/stellar-sdk';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutboxStatus = 'pending' | 'confirmed' | 'failed';

export interface OutboxEntry {
  hash: string;
  sequence: string;
  xdr: string;
  networkPassphrase: string;
  createdAt: number;
  attempts: number;
  status: OutboxStatus;
  lastError?: string;
}

export interface ReplayResult {
  confirmed: OutboxEntry[];
  failed: OutboxEntry[];
  stillPending: OutboxEntry[];
  skippedDuplicate: OutboxEntry[];
}

export interface ReplayOptions {
  waitForConfirmation?: boolean;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
}

const DEFAULT_STORAGE_KEY = 'veil_mobile_outbox';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_MAX_ATTEMPTS = 30;

// ── Outbox ────────────────────────────────────────────────────────────────────

/**
 * Durable transaction queue backed by AsyncStorage.
 *
 * @example
 * const outbox = new MobileOutbox();
 * await outbox.enqueue({ hash, sequence, xdr, networkPassphrase });
 * // on reconnect:
 * const { confirmed, failed } = await outbox.replay(server);
 */
export class MobileOutbox {
  private readonly key: string;

  constructor(opts?: { key?: string }) {
    this.key = opts?.key ?? DEFAULT_STORAGE_KEY;
  }

  async list(): Promise<OutboxEntry[]> {
    try {
      const raw = await AsyncStorage.getItem(this.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
    } catch {
      return [];
    }
  }

  async pending(): Promise<OutboxEntry[]> {
    const all = await this.list();
    return all
      .filter((e) => e.status === 'pending')
      .sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1));
  }

  private async persist(entries: OutboxEntry[]): Promise<void> {
    await AsyncStorage.setItem(this.key, JSON.stringify(entries));
  }

  async enqueue(input: {
    hash: string;
    sequence: string | number | bigint;
    xdr: string;
    networkPassphrase: string;
  }): Promise<OutboxEntry> {
    const entries = await this.list();
    const existing = entries.find((e) => e.hash === input.hash);
    if (existing) return existing;

    const entry: OutboxEntry = {
      hash: input.hash,
      sequence: String(input.sequence),
      xdr: input.xdr,
      networkPassphrase: input.networkPassphrase,
      createdAt: Date.now(),
      attempts: 0,
      status: 'pending',
    };
    entries.push(entry);
    await this.persist(entries);
    return entry;
  }

  async remove(hash: string): Promise<void> {
    const entries = await this.list();
    const next = entries.filter((e) => e.hash !== hash);
    if (next.length !== entries.length) await this.persist(next);
  }

  async clear(): Promise<void> {
    await this.persist([]);
  }

  async replay(
    server: SorobanRpc.Server,
    opts?: ReplayOptions,
  ): Promise<ReplayResult> {
    const waitForConfirmation = opts?.waitForConfirmation ?? true;
    const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const pollMaxAttempts =
      opts?.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;

    const result: ReplayResult = {
      confirmed: [],
      failed: [],
      stillPending: [],
      skippedDuplicate: [],
    };

    const pending = await this.pending();
    const toRemove = new Set<string>();
    const mutations = new Map<string, Partial<OutboxEntry>>();

    for (const entry of pending) {
      // Dedup: is the hash already known to the network?
      try {
        const known = await server.getTransaction(entry.hash);
        if (
          known.status ===
          SorobanRpc.Api.GetTransactionStatus.SUCCESS
        ) {
          result.skippedDuplicate.push({ ...entry, status: 'confirmed' });
          toRemove.add(entry.hash);
          continue;
        }
        if (
          known.status === SorobanRpc.Api.GetTransactionStatus.FAILED
        ) {
          result.failed.push({ ...entry, status: 'failed' });
          toRemove.add(entry.hash);
          continue;
        }
      } catch {
        result.stillPending.push(entry);
        continue;
      }

      // Submit the stored envelope
      mutations.set(entry.hash, { attempts: entry.attempts + 1 });
      let tx: Transaction | FeeBumpTransaction;
      try {
        tx = TransactionBuilder.fromXDR(entry.xdr, entry.networkPassphrase);
      } catch (err) {
        mutations.set(entry.hash, {
          attempts: entry.attempts + 1,
          status: 'failed',
          lastError: err instanceof Error ? err.message : String(err),
        });
        result.failed.push({ ...entry, status: 'failed' });
        toRemove.add(entry.hash);
        continue;
      }

      try {
        const sendResult = await server.sendTransaction(tx);

        if (sendResult.status === 'ERROR') {
          const msg =
            sendResult.errorResult?.toXDR('base64') ?? 'unknown error';
          mutations.set(entry.hash, {
            attempts: entry.attempts + 1,
            status: 'failed',
            lastError: `Transaction rejected: ${msg}`,
          });
          result.failed.push({
            ...entry,
            status: 'failed',
            lastError: msg,
          });
          toRemove.add(entry.hash);
          continue;
        }

        if (!waitForConfirmation) {
          result.stillPending.push(entry);
          continue;
        }

        const finalStatus = await this.waitFor(
          server,
          entry.hash,
          pollIntervalMs,
          pollMaxAttempts,
        );
        if (finalStatus === 'SUCCESS') {
          result.confirmed.push({ ...entry, status: 'confirmed' });
          toRemove.add(entry.hash);
        } else if (finalStatus === 'FAILED') {
          mutations.set(entry.hash, {
            attempts: entry.attempts + 1,
            status: 'failed',
            lastError: 'Transaction failed on-chain',
          });
          result.failed.push({ ...entry, status: 'failed' });
          toRemove.add(entry.hash);
        } else {
          result.stillPending.push(entry);
        }
      } catch (err) {
        mutations.set(entry.hash, {
          attempts: entry.attempts + 1,
          lastError: err instanceof Error ? err.message : String(err),
        });
        result.stillPending.push(entry);
      }
    }

    // Persist the post-pass queue
    const all = await this.list();
    const next = all
      .filter((e) => !toRemove.has(e.hash))
      .map((e) => {
        const patch = mutations.get(e.hash);
        return patch ? { ...e, ...patch } : e;
      });
    await this.persist(next);

    return result;
  }

  private async waitFor(
    server: SorobanRpc.Server,
    hash: string,
    intervalMs: number,
    maxAttempts: number,
  ): Promise<'SUCCESS' | 'FAILED' | 'TIMEOUT'> {
    for (let i = 0; i < maxAttempts; i++) {
      const res = await server.getTransaction(hash);
      if (
        res.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS
      )
        return 'SUCCESS';
      if (
        res.status === SorobanRpc.Api.GetTransactionStatus.FAILED
      )
        return 'FAILED';
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return 'TIMEOUT';
  }
}

// ── Auto-replay hook ──────────────────────────────────────────────────────────

/**
 * React hook that monitors network connectivity and automatically replays
 * pending outbox entries when the device comes back online.
 *
 * @param outbox  A {@link MobileOutbox} instance.
 * @param rpcUrl  Soroban RPC endpoint used to create the server for replay.
 * @param opts    Optional replay options forwarded to {@link MobileOutbox.replay}.
 * @returns       A cleanup function that removes the NetInfo listener.
 */
export function useAutoReplayOutbox(
  outbox: MobileOutbox,
  rpcUrl: string,
  opts?: ReplayOptions,
): () => void {
  const replay = async (state: NetInfoState) => {
    if (!state.isConnected) return;
    try {
      const server = new SorobanRpc.Server(rpcUrl);
      await outbox.replay(server, opts);
    } catch {
      // Swallow — per-entry errors are recorded in lastError.
    }
  };

  const unsubscribe = NetInfo.addEventListener(replay);

  // Also replay immediately on mount in case there are stale entries.
  void NetInfo.fetch().then(replay);

  return unsubscribe;
}
