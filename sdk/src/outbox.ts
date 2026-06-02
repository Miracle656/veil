/**
 * Offline transaction outbox with reconnect replay.
 *
 * On flaky mobile connections a submitted transaction can be lost before it
 * reaches the network. The outbox is a durable, persisted queue that records a
 * fully-signed transaction *before* it is sent, then replays anything still
 * outstanding when connectivity returns.
 *
 * ── At-most-once submission ──────────────────────────────────────────────────
 * Two independent properties combine to make replay safe:
 *
 *   1. **Tx hash dedup.** A Stellar transaction hash is a deterministic function
 *      of its signed envelope. Re-submitting the exact same envelope produces
 *      the same hash, which the network rejects as a DUPLICATE. Before sending
 *      we additionally query `getTransaction(hash)`; if the network already
 *      knows the hash we never resend.
 *
 *   2. **Sequence-number dedup.** Each entry records its source-account sequence
 *      number. Even a hypothetical re-signed transaction reusing that sequence
 *      would be rejected by the network (`tx_bad_seq`) once the first one is
 *      applied — so a queued transaction can be applied at most once.
 *
 * The outbox itself is storage-agnostic: it persists through the same
 * {@link StorageAdapter} the wallet already uses (localStorage on web,
 * AsyncStorage on React Native), so queued transactions survive a reload.
 */

import {
    rpc as SorobanRpc,
    TransactionBuilder,
    type Transaction,
    type FeeBumpTransaction,
} from '@stellar/stellar-sdk';
// Type-only import — erased at compile time, so this does not create a runtime
// cycle with useInvisibleWallet (which imports this module).
import type { StorageAdapter } from './useInvisibleWallet';

// ── Types ─────────────────────────────────────────────────────────────────────

export type OutboxStatus = 'pending' | 'confirmed' | 'failed';

/** A single queued transaction. Serialised as JSON in the storage adapter. */
export interface OutboxEntry {
    /** Stable identifier — the transaction hash (hex). Doubles as the dedup key. */
    hash: string;
    /** Source-account sequence number this transaction consumes (decimal string). */
    sequence: string;
    /** Base64-encoded signed transaction envelope, ready to submit as-is. */
    xdr: string;
    /** Network passphrase the envelope was signed for. */
    networkPassphrase: string;
    /** Unix epoch milliseconds when the entry was enqueued. */
    createdAt: number;
    /** Number of times replay has attempted to submit this entry. */
    attempts: number;
    /** Lifecycle status. Confirmed/failed entries are pruned from the queue. */
    status: OutboxStatus;
    /** Last error message, if a submission attempt failed. */
    lastError?: string;
}

/** Outcome of a {@link TransactionOutbox.replay} pass. */
export interface ReplayResult {
    /** Entries confirmed on-chain during this pass (now removed from the queue). */
    confirmed: OutboxEntry[];
    /** Entries the network rejected/failed (now removed from the queue). */
    failed: OutboxEntry[];
    /** Entries still awaiting confirmation — left in the queue for a later pass. */
    stillPending: OutboxEntry[];
    /**
     * Entries that were already present on-chain when replay started, i.e. the
     * original submission *did* land. Removed from the queue without resending —
     * this is the core at-most-once protection.
     */
    skippedDuplicate: OutboxEntry[];
}

/** Options controlling a replay pass. */
export interface ReplayOptions {
    /**
     * When true (default) each freshly-sent transaction is polled until it
     * leaves NOT_FOUND or the attempt budget is exhausted. When false, replay
     * sends and returns immediately, leaving confirmation to a later pass.
     */
    waitForConfirmation?: boolean;
    /** Poll interval in ms while waiting for confirmation. Default 1000. */
    pollIntervalMs?: number;
    /** Maximum poll attempts before giving up on confirmation. Default 30. */
    pollMaxAttempts?: number;
}

const DEFAULT_STORAGE_KEY = 'invisible_wallet_outbox';
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_MAX_ATTEMPTS = 30;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise a possibly-async StorageAdapter read into a Promise. */
async function readItem(store: StorageAdapter, key: string): Promise<string | null> {
    return Promise.resolve(store.getItem(key));
}

// ── Outbox ────────────────────────────────────────────────────────────────────

/**
 * A durable transaction queue backed by a {@link StorageAdapter}.
 *
 * @example
 * const outbox = new TransactionOutbox(storage);
 * // before sending, record the signed envelope:
 * await outbox.enqueue({ hash, sequence, xdr, networkPassphrase });
 * // on reconnect:
 * const { confirmed, failed } = await outbox.replay(server);
 */
export class TransactionOutbox {
    private readonly store: StorageAdapter;
    private readonly key: string;

    constructor(store: StorageAdapter, opts?: { key?: string }) {
        this.store = store;
        this.key = opts?.key ?? DEFAULT_STORAGE_KEY;
    }

    /** Read and parse the persisted queue. Returns [] if empty or corrupt. */
    async list(): Promise<OutboxEntry[]> {
        const raw = await readItem(this.store, this.key);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? (parsed as OutboxEntry[]) : [];
        } catch {
            // Corrupt payload — treat as empty rather than throwing on read.
            return [];
        }
    }

    /** Entries still awaiting confirmation, ordered by sequence number ascending. */
    async pending(): Promise<OutboxEntry[]> {
        const all = await this.list();
        return all
            .filter(e => e.status === 'pending')
            .sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1));
    }

    private async persist(entries: OutboxEntry[]): Promise<void> {
        await Promise.resolve(this.store.setItem(this.key, JSON.stringify(entries)));
    }

    /**
     * Record a signed transaction in the queue. Idempotent: enqueuing a hash
     * that is already present updates nothing and returns the existing entry,
     * so a retry that re-enqueues the same envelope cannot create a duplicate.
     */
    async enqueue(input: {
        hash: string;
        sequence: string | number | bigint;
        xdr: string;
        networkPassphrase: string;
    }): Promise<OutboxEntry> {
        const entries = await this.list();
        const existing = entries.find(e => e.hash === input.hash);
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

    /** Remove an entry by hash, regardless of status. */
    async remove(hash: string): Promise<void> {
        const entries = await this.list();
        const next = entries.filter(e => e.hash !== hash);
        if (next.length !== entries.length) await this.persist(next);
    }

    /** Empty the entire queue. */
    async clear(): Promise<void> {
        await this.persist([]);
    }

    /**
     * Replay every pending entry against the network.
     *
     * For each entry, in sequence order:
     *   1. Ask the network whether the hash is already known.
     *      - SUCCESS → the original submission landed; drop without resending.
     *      - FAILED  → the transaction was applied and failed; drop, do not retry
     *        (resending the identical envelope would fail identically).
     *      - NOT_FOUND → submit the stored envelope.
     *   2. After submitting, optionally poll until the transaction confirms.
     *
     * Confirmed, failed and already-on-chain entries are pruned from the queue;
     * entries still in flight are left for the next pass.
     */
    async replay(server: SorobanRpc.Server, opts?: ReplayOptions): Promise<ReplayResult> {
        const waitForConfirmation = opts?.waitForConfirmation ?? true;
        const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        const pollMaxAttempts = opts?.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;

        const result: ReplayResult = {
            confirmed: [],
            failed: [],
            stillPending: [],
            skippedDuplicate: [],
        };

        const pending = await this.pending();
        // Hashes to drop from the queue once the pass completes.
        const toRemove = new Set<string>();
        // In-place status/attempt mutations to persist back.
        const mutations = new Map<string, Partial<OutboxEntry>>();

        for (const entry of pending) {
            // ── 1. Dedup: is the hash already known to the network? ──────────
            try {
                const known = await server.getTransaction(entry.hash);
                if (known.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                    result.skippedDuplicate.push({ ...entry, status: 'confirmed' });
                    toRemove.add(entry.hash);
                    continue;
                }
                if (known.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
                    result.failed.push({ ...entry, status: 'failed' });
                    toRemove.add(entry.hash);
                    continue;
                }
                // NOT_FOUND → fall through and submit.
            } catch {
                // Status lookup failed (e.g. still offline). Leave for next pass.
                result.stillPending.push(entry);
                continue;
            }

            // ── 2. Submit the stored envelope ────────────────────────────────
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
                    const msg = sendResult.errorResult?.toXDR('base64') ?? 'unknown error';
                    mutations.set(entry.hash, {
                        attempts: entry.attempts + 1,
                        status: 'failed',
                        lastError: `Transaction rejected: ${msg}`,
                    });
                    result.failed.push({ ...entry, status: 'failed', lastError: msg });
                    toRemove.add(entry.hash);
                    continue;
                }

                // 'DUPLICATE' / 'TRY_AGAIN_LATER' / 'PENDING' → still in flight.
                if (!waitForConfirmation) {
                    result.stillPending.push(entry);
                    continue;
                }

                const final = await this.waitFor(server, entry.hash, pollIntervalMs, pollMaxAttempts);
                if (final === 'SUCCESS') {
                    result.confirmed.push({ ...entry, status: 'confirmed' });
                    toRemove.add(entry.hash);
                } else if (final === 'FAILED') {
                    mutations.set(entry.hash, {
                        attempts: entry.attempts + 1,
                        status: 'failed',
                        lastError: 'Transaction failed on-chain',
                    });
                    result.failed.push({ ...entry, status: 'failed' });
                    toRemove.add(entry.hash);
                } else {
                    // Timed out waiting — keep it queued for the next pass.
                    result.stillPending.push(entry);
                }
            } catch (err) {
                // Network blip mid-send — keep queued, record the error.
                mutations.set(entry.hash, {
                    attempts: entry.attempts + 1,
                    lastError: err instanceof Error ? err.message : String(err),
                });
                result.stillPending.push(entry);
            }
        }

        // ── Persist the post-pass queue ──────────────────────────────────────
        const all = await this.list();
        const next = all
            .filter(e => !toRemove.has(e.hash))
            .map(e => {
                const patch = mutations.get(e.hash);
                return patch ? { ...e, ...patch } : e;
            });
        await this.persist(next);

        return result;
    }

    /** Poll until the hash leaves NOT_FOUND, or attempts run out. */
    private async waitFor(
        server: SorobanRpc.Server,
        hash: string,
        intervalMs: number,
        maxAttempts: number,
    ): Promise<'SUCCESS' | 'FAILED' | 'TIMEOUT'> {
        for (let i = 0; i < maxAttempts; i++) {
            const res = await server.getTransaction(hash);
            if (res.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) return 'SUCCESS';
            if (res.status === SorobanRpc.Api.GetTransactionStatus.FAILED) return 'FAILED';
            await new Promise(r => setTimeout(r, intervalMs));
        }
        return 'TIMEOUT';
    }
}
