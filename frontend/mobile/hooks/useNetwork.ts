import { useCallback, useState, useSyncExternalStore } from 'react';

import {
  getNetwork,
  getNetworkName,
  setNetwork,
  subscribeToNetwork,
  type VeilNetwork,
  type VeilNetworkName,
} from '../lib/network';

export type UseNetwork = {
  /** The active network's full configuration. */
  network: VeilNetwork;
  /** The active network's name. */
  networkName: VeilNetworkName;
  /** Switch networks and persist the choice. */
  switchNetwork: (name: VeilNetworkName) => Promise<void>;
  /** True while a switch is being written to storage. */
  isSwitching: boolean;
  /** The error from the last failed switch, if any. */
  error: string | null;
};

/**
 * Subscribe a component to the active network.
 *
 * The snapshot is the network *name* rather than the config object, because
 * `useSyncExternalStore` compares snapshots by identity and `getNetwork()`
 * would need to return a stable reference to be safe here. The name is a
 * string, so equality is value equality and re-renders happen exactly when the
 * network actually changes.
 *
 * Components that hold network-dependent state — balances, history, an RPC
 * client — should key it on `networkName` (or refetch when it changes), since a
 * switch invalidates everything fetched from the previous chain.
 */
export function useNetwork(): UseNetwork {
  const networkName = useSyncExternalStore(subscribeToNetwork, getNetworkName, getNetworkName);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchNetwork = useCallback(async (name: VeilNetworkName) => {
    setIsSwitching(true);
    setError(null);
    try {
      await setNetwork(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch network.');
    } finally {
      setIsSwitching(false);
    }
  }, []);

  return {
    network: getNetwork(),
    networkName,
    switchNetwork,
    isSwitching,
    error,
  };
}
