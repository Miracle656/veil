import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  enqueueOutboxAction,
  flushOutbox,
  hydrateOutbox,
  subscribeOutbox,
  type FlushSummary,
  type OutboxAction,
} from './outbox';

/**
 * Connectivity provider.
 *
 * Wraps the app so any screen can ask whether the device is online, and so a
 * loss of connectivity surfaces the dedicated offline screen instead of letting
 * network calls fail silently. When the device comes back online the offline
 * outbox is flushed automatically.
 */

export type ConnectivityValue = {
  /** True unless NetInfo positively reports no usable connection. */
  isOnline: boolean;
  /** Raw NetInfo link state — null until the first update arrives. */
  isConnected: boolean | null;
  /**
   * Whether the connection actually reaches the internet. Null means NetInfo
   * has not determined it yet (common on first render and on iOS simulators).
   */
  isInternetReachable: boolean | null;
  /** NetInfo connection type, e.g. `wifi`, `cellular`, `none`. */
  connectionType: string;
  /** Actions waiting in the outbox for connectivity to return. */
  pendingActions: OutboxAction[];
  /** Queue an action to run once the device is back online. */
  enqueue: (type: string, payload: unknown) => Promise<OutboxAction>;
  /** Re-probe the network immediately, e.g. from a "Try again" button. */
  refresh: () => Promise<boolean>;
  /** Run the outbox now. Resolves with what happened to each queued action. */
  flush: () => Promise<FlushSummary>;
};

const ConnectivityContext = createContext<ConnectivityValue | null>(null);

/**
 * NetInfo reports `isInternetReachable: null` while it is still probing, and
 * `isConnected: null` before the first event. Treat unknown as online so the
 * offline screen only ever appears on a positive "no connection" signal.
 */
function resolveIsOnline(state: Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>): boolean {
  if (state.isConnected === false) return false;
  if (state.isInternetReachable === false) return false;
  return true;
}

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [isInternetReachable, setIsInternetReachable] = useState<boolean | null>(null);
  const [connectionType, setConnectionType] = useState<string>('unknown');
  const [pendingActions, setPendingActions] = useState<OutboxAction[]>([]);

  const wasOnlineRef = useRef(true);

  const isOnline = resolveIsOnline({ isConnected, isInternetReachable });

  const applyState = useCallback((state: NetInfoState) => {
    setIsConnected(state.isConnected);
    setIsInternetReachable(state.isInternetReachable);
    setConnectionType(state.type);
  }, []);

  useEffect(() => {
    void hydrateOutbox();
    return subscribeOutbox(setPendingActions);
  }, []);

  useEffect(() => {
    // `addEventListener` fires once with the current state on subscribe, so no
    // separate initial fetch is needed.
    return NetInfo.addEventListener(applyState);
  }, [applyState]);

  useEffect(() => {
    const wasOnline = wasOnlineRef.current;
    wasOnlineRef.current = isOnline;
    if (isOnline && !wasOnline) {
      flushOutbox().catch((error) => {
        console.warn('[connectivity] outbox flush failed', error);
      });
    }
  }, [isOnline]);

  const refresh = useCallback(async () => {
    const state = await NetInfo.refresh();
    applyState(state);
    return resolveIsOnline(state);
  }, [applyState]);

  const value = useMemo<ConnectivityValue>(
    () => ({
      isOnline,
      isConnected,
      isInternetReachable,
      connectionType,
      pendingActions,
      enqueue: enqueueOutboxAction,
      refresh,
      flush: flushOutbox,
    }),
    [connectionType, isConnected, isInternetReachable, isOnline, pendingActions, refresh]
  );

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): ConnectivityValue {
  const value = useContext(ConnectivityContext);
  if (!value) {
    throw new Error('useConnectivity must be used inside a <ConnectivityProvider>.');
  }
  return value;
}
