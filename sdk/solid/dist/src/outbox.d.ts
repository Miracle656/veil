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
import { rpc as SorobanRpc } from '@stellar/stellar-sdk';
import type { StorageAdapter } from './useInvisibleWallet';
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
export declare class TransactionOutbox {
    private readonly store;
    private readonly key;
    constructor(store: StorageAdapter, opts?: {
        key?: string;
    });
    /** Read and parse the persisted queue. Returns [] if empty or corrupt. */
    list(): Promise<OutboxEntry[]>;
    /** Entries still awaiting confirmation, ordered by sequence number ascending. */
    pending(): Promise<OutboxEntry[]>;
    private persist;
    /**
     * Record a signed transaction in the queue. Idempotent: enqueuing a hash
     * that is already present updates nothing and returns the existing entry,
     * so a retry that re-enqueues the same envelope cannot create a duplicate.
     */
    enqueue(input: {
        hash: string;
        sequence: string | number | bigint;
        xdr: string;
        networkPassphrase: string;
    }): Promise<OutboxEntry>;
    /** Remove an entry by hash, regardless of status. */
    remove(hash: string): Promise<void>;
    /** Empty the entire queue. */
    clear(): Promise<void>;
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
    replay(server: SorobanRpc.Server, opts?: ReplayOptions): Promise<ReplayResult>;
    /** Poll until the hash leaves NOT_FOUND, or attempts run out. */
    private waitFor;
}
