import { useEffect, useCallback, useState } from 'react';
import { useConnectivity } from '../lib/connectivity';
import { useWallet } from '../components/WalletProvider';

/**
 * Hook that replays the SDK's Stellar transaction outbox when connectivity
 * returns. The SDK's outbox persists signed transactions in AsyncStorage so
 * they survive app restarts; this hook triggers replay on the offline → online
 * transition detected by the ConnectivityProvider.
 *
 * The generic action outbox (payments, swaps, etc.) is already flushed by
 * the ConnectivityProvider itself — this hook covers only the SDK-level
 * transaction outbox that handles Stellar-specific dedup and confirmation.
 *
 * @example
 * const { outbox, replayOutbox, isReplaying } = useOutboxReplay();
 *
 * // Queue a signed transaction for offline resilience:
 * await outbox.enqueue({ hash, sequence, xdr, networkPassphrase });
 *
 * // Replay happens automatically on reconnect, or call manually:
 * const result = await replayOutbox();
 */
export function useOutboxReplay() {
  const { wallet } = useWallet();
  const { isOnline } = useConnectivity();
  const [isReplaying, setIsReplaying] = useState(false);

  const { outbox, replayOutbox: sdkReplayOutbox } = wallet;

  // Track previous online state internally — no shared ref across effects.
  const [wasOnline, setWasOnline] = useState(true);

  useEffect(() => {
    const prev = wasOnline;
    setWasOnline(isOnline);

    // Trigger replay on offline → online transition only.
    if (isOnline && !prev && !isReplaying) {
      setIsReplaying(true);
      sdkReplayOutbox()
        .catch((error) => {
          console.warn('[useOutboxReplay] SDK outbox replay failed', error);
        })
        .finally(() => {
          setIsReplaying(false);
        });
    }
  }, [isOnline]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Manually trigger replay of all pending transactions. */
  const replay = useCallback(async () => {
    if (isReplaying) {
      return { confirmed: [], failed: [], stillPending: [], skippedDuplicate: [] };
    }
    setIsReplaying(true);
    try {
      return await sdkReplayOutbox();
    } finally {
      setIsReplaying(false);
    }
  }, [sdkReplayOutbox, isReplaying]);

  return {
    /** The SDK's TransactionOutbox instance for enqueueing signed transactions. */
    outbox,
    /** Manually trigger replay of queued transactions. */
    replayOutbox: replay,
    /** Whether a replay is currently in progress. */
    isReplaying,
  };
}
