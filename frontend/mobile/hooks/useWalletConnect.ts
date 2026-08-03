import { useCallback, useEffect, useState } from 'react';

import {
  approveSession as approveWalletConnectSession,
  disconnectAllSessions as disconnectAllWalletConnectSessions,
  disconnectSession as disconnectWalletConnectSession,
  getWalletConnectClient,
  pairWalletConnect,
  rejectSession as rejectWalletConnectSession,
  subscribeWalletConnectProposal,
  subscribeWalletConnectRequests,
  subscribeWalletConnectSessions,
  type WalletConnectProposal,
  type WalletConnectRequest,
  type WalletConnectSession,
} from '../lib/walletConnect';

export type UseWalletConnect = {
  /** True once the WalletConnect client has finished initialising. */
  isReady: boolean;
  /** Why initialisation failed, e.g. a missing project id. */
  error: string | null;
  sessions: WalletConnectSession[];
  /** Session proposal awaiting approval, if any. */
  pendingProposal: WalletConnectProposal | null;
  /** Sign requests awaiting approval, oldest first. */
  pendingRequests: WalletConnectRequest[];
  pair: (uri: string) => Promise<void>;
  approveSession: (proposal: WalletConnectProposal, contractAddress: string) => Promise<void>;
  rejectSession: (proposal: WalletConnectProposal) => Promise<void>;
  disconnectSession: (topic: string) => Promise<void>;
  disconnectAll: () => Promise<void>;
};

/**
 * React binding over `lib/walletConnect`. The underlying store lives outside
 * React, so every consumer of this hook observes the same sessions, proposal
 * and request queue no matter where it is mounted.
 */
export function useWalletConnect(): UseWalletConnect {
  const [sessions, setSessions] = useState<WalletConnectSession[]>([]);
  const [pendingProposal, setPendingProposal] = useState<WalletConnectProposal | null>(null);
  const [pendingRequests, setPendingRequests] = useState<WalletConnectRequest[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    getWalletConnectClient()
      .then(() => {
        if (!mounted) return;
        setIsReady(true);
        setError(null);
      })
      .catch((initError: unknown) => {
        if (!mounted) return;
        setIsReady(false);
        setError(initError instanceof Error ? initError.message : String(initError));
      });

    const unsubscribeSessions = subscribeWalletConnectSessions(setSessions);
    const unsubscribeProposal = subscribeWalletConnectProposal(setPendingProposal);
    const unsubscribeRequests = subscribeWalletConnectRequests(setPendingRequests);

    return () => {
      mounted = false;
      unsubscribeSessions();
      unsubscribeProposal();
      unsubscribeRequests();
    };
  }, []);

  const pair = useCallback(async (uri: string) => {
    await pairWalletConnect(uri);
  }, []);

  const approveSession = useCallback(
    async (proposal: WalletConnectProposal, contractAddress: string) => {
      await approveWalletConnectSession(proposal, contractAddress);
    },
    []
  );

  const rejectSession = useCallback(async (proposal: WalletConnectProposal) => {
    await rejectWalletConnectSession(proposal);
  }, []);

  const disconnectSession = useCallback(async (topic: string) => {
    await disconnectWalletConnectSession(topic);
  }, []);

  const disconnectAll = useCallback(async () => {
    await disconnectAllWalletConnectSessions();
  }, []);

  return {
    isReady,
    error,
    sessions,
    pendingProposal,
    pendingRequests,
    pair,
    approveSession,
    rejectSession,
    disconnectSession,
    disconnectAll,
  };
}
