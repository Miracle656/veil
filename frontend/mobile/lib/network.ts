/**
 * Network selection for the mobile app.
 *
 * The web wallet picks its network from `NEXT_PUBLIC_NETWORK` at build time
 * (`frontend/wallet/lib/network.ts`). That does not work on mobile: a build is a
 * store submission, and a tester switching between testnet and mainnet cannot
 * wait on one. So the build-time environment supplies the *default*, and a
 * persisted override in AsyncStorage can point the app somewhere else at
 * runtime.
 *
 * Resolution order for the active network:
 *
 *   1. A persisted override the user chose in settings.
 *   2. `EXPO_PUBLIC_NETWORK` from the build.
 *   3. Testnet.
 *
 * Reads are synchronous — module consumers call {@link getNetwork} without
 * awaiting anything. Hydration from storage happens once, on first import, and
 * notifies subscribers when it lands so anything already rendered re-reads.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Networks } from '@stellar/stellar-sdk';

export type VeilNetworkName = 'testnet' | 'mainnet';

export type VeilNetwork = {
  name: VeilNetworkName;
  displayName: string;
  networkPassphrase: string;
  horizonUrl: string;
  rpcUrl: string;
  factoryContractId: string;
  friendbotUrl: string | null;
};

/** AsyncStorage key holding the user's runtime network choice. */
export const NETWORK_OVERRIDE_KEY = 'veil_network_override';

export const NETWORKS: Record<VeilNetworkName, VeilNetwork> = {
  testnet: {
    name: 'testnet',
    displayName: 'Stellar Testnet',
    networkPassphrase: Networks.TESTNET,
    horizonUrl:
      process.env['EXPO_PUBLIC_HORIZON_URL']?.trim() || 'https://horizon-testnet.stellar.org',
    rpcUrl:
      process.env['EXPO_PUBLIC_SOROBAN_RPC_URL']?.trim()
      || process.env['EXPO_PUBLIC_RPC_URL']?.trim()
      || 'https://soroban-testnet.stellar.org',
    factoryContractId:
      process.env['EXPO_PUBLIC_FACTORY_CONTRACT_ID_TESTNET']?.trim()
      || process.env['EXPO_PUBLIC_FACTORY_CONTRACT_ID']?.trim()
      || '',
    friendbotUrl: 'https://friendbot.stellar.org',
  },
  mainnet: {
    name: 'mainnet',
    displayName: 'Stellar Mainnet',
    networkPassphrase: Networks.PUBLIC,
    horizonUrl: process.env['EXPO_PUBLIC_MAINNET_HORIZON_URL']?.trim() || 'https://horizon.stellar.org',
    rpcUrl: process.env['EXPO_PUBLIC_MAINNET_RPC_URL']?.trim() || '',
    factoryContractId: process.env['EXPO_PUBLIC_FACTORY_CONTRACT_ID_MAINNET']?.trim() || '',
    friendbotUrl: null,
  },
};

export const NETWORK_NAMES = Object.keys(NETWORKS) as VeilNetworkName[];

/** Narrow an arbitrary string to a known network name. */
export function isNetworkName(value: unknown): value is VeilNetworkName {
  return typeof value === 'string' && value in NETWORKS;
}

/** The network the build was configured for, before any runtime override. */
export function getBuildTimeNetworkName(): VeilNetworkName {
  const configured = process.env['EXPO_PUBLIC_NETWORK']?.trim();
  return isNetworkName(configured) ? configured : 'testnet';
}

// ── Active network ───────────────────────────────────────────────────────────────

let activeName: VeilNetworkName = getBuildTimeNetworkName();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribe to network changes. Consumers holding network-dependent state —
 * balances, transaction history, an RPC client — should refetch when this fires,
 * because the chain underneath them has changed.
 *
 * @returns An unsubscribe function.
 */
export function subscribeToNetwork(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The active network's name. Cheap enough to call in a render. */
export function getNetworkName(): VeilNetworkName {
  return activeName;
}

/** The active network's full configuration. */
export function getNetwork(): VeilNetwork {
  return NETWORKS[activeName];
}

// ── Hydration ────────────────────────────────────────────────────────────────────

let hydration: Promise<VeilNetworkName> | null = null;

async function readOverride(): Promise<VeilNetworkName | null> {
  try {
    const stored = await AsyncStorage.getItem(NETWORK_OVERRIDE_KEY);
    return isNetworkName(stored) ? stored : null;
  } catch {
    // Storage being unavailable is not worth failing the app over — the
    // build-time network is a working default.
    return null;
  }
}

/**
 * Load the persisted override into the module. Idempotent: repeated calls share
 * one read, so importing this module from several places costs one storage hit.
 */
export function hydrateNetwork(): Promise<VeilNetworkName> {
  hydration ??= readOverride().then((stored) => {
    if (stored && stored !== activeName) {
      activeName = stored;
      notify();
    }
    return activeName;
  });
  return hydration;
}

// Kick hydration off at import so `getNetwork()` settles on the user's choice
// without every call site having to remember to await it first.
void hydrateNetwork();

// ── Switching ────────────────────────────────────────────────────────────────────

/**
 * Switch the active network and persist the choice.
 *
 * The in-memory value is updated only after the write succeeds, so a failed
 * write cannot leave the app pointed at a network it will forget on next launch.
 *
 * @returns `true` if the network changed, `false` if it was already active.
 */
export async function setNetwork(name: VeilNetworkName): Promise<boolean> {
  if (!isNetworkName(name)) throw new Error(`Unknown network: ${name}`);
  if (name === activeName) return false;

  await AsyncStorage.setItem(NETWORK_OVERRIDE_KEY, name);
  // Ensure a later hydrate cannot resurrect the previous value.
  hydration = Promise.resolve(name);
  activeName = name;
  notify();
  return true;
}

/** Drop the override and fall back to the network the build was configured for. */
export async function clearNetworkOverride(): Promise<void> {
  await AsyncStorage.removeItem(NETWORK_OVERRIDE_KEY);
  hydration = Promise.resolve(getBuildTimeNetworkName());
  if (activeName !== getBuildTimeNetworkName()) {
    activeName = getBuildTimeNetworkName();
    notify();
  }
}

// ── Derived helpers ──────────────────────────────────────────────────────────────

/**
 * Whether the active network has everything it needs to talk to a chain. Mainnet
 * ships with no default RPC or factory, so selecting it in a build that was not
 * configured for it would fail later, in a request, with a worse error message.
 */
export function isNetworkConfigured(network = getNetwork()): boolean {
  return network.rpcUrl.length > 0 && network.factoryContractId.length > 0;
}

/** Human-readable list of what a network is missing, for a settings warning. */
export function describeMissingConfig(network = getNetwork()): string[] {
  const missing: string[] = [];
  if (!network.rpcUrl) missing.push('Soroban RPC URL');
  if (!network.factoryContractId) missing.push('factory contract ID');
  return missing;
}

/** Friendbot funding URL for `address`, or null on networks without a faucet. */
export function buildFriendbotUrl(address: string, network = getNetwork()): string | null {
  if (!network.friendbotUrl) return null;
  const url = new URL(network.friendbotUrl);
  url.searchParams.set('addr', address);
  return url.toString();
}
