import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';

import { getNetwork, type VeilNetwork, type VeilNetworkName } from './network';

/**
 * The facts behind the About screen: which build is installed, which network it
 * is pointed at, which contracts it talks to, and where to go for help.
 *
 * Everything here is derived rather than stored, so the screen cannot drift from
 * what the app is actually running: the version comes from the native build (or
 * the Expo config when running in Expo Go), and the network and contract
 * addresses come from the same `lib/network.ts` the rest of the app signs with.
 */

export type AppVersion = {
  /** Marketing version, e.g. "0.1.0". */
  version: string;
  /** Native build identifier (iOS build number / Android versionCode), if any. */
  build: string | null;
};

const UNKNOWN_VERSION = 'unknown';

/**
 * The installed app's version.
 *
 * `nativeApplicationVersion` is the truth for a real build; it is null in Expo
 * Go and on web, where the app.json value is the closest thing available.
 */
export function getAppVersion(): AppVersion {
  const version =
    Constants.nativeApplicationVersion?.trim()
    || Constants.expoConfig?.version?.trim()
    || UNKNOWN_VERSION;

  const build = Constants.nativeBuildVersion?.trim() || null;

  return { version, build };
}

export type NetworkFact = { key: string; label: string; value: string };

/** The network the app is signing against, as label/value rows. */
export function getNetworkFacts(network: VeilNetwork = getNetwork()): NetworkFact[] {
  return [
    { key: 'network', label: 'Network', value: network.displayName },
    { key: 'rpc', label: 'Soroban RPC', value: network.rpcUrl || 'Not configured' },
    { key: 'horizon', label: 'Horizon', value: network.horizonUrl },
  ];
}

export type ContractEntry = {
  key: string;
  label: string;
  /** Stellar address, or null when this build has no value configured. */
  address: string | null;
};

/**
 * The contracts this build interacts with. The wallet address is passed in
 * rather than read here so the caller controls when the keychain is touched.
 */
export function getContractEntries(
  walletAddress: string | null,
  network: VeilNetwork = getNetwork()
): ContractEntry[] {
  return [
    { key: 'wallet', label: 'Your wallet', address: walletAddress?.trim() || null },
    { key: 'factory', label: 'Wallet factory', address: network.factoryContractId || null },
  ];
}

/** stellar.expert's path segment for a network — "public" for mainnet. */
export function explorerNetworkSegment(name: VeilNetworkName): string {
  return name === 'mainnet' ? 'public' : 'testnet';
}

/**
 * Explorer URL for a Stellar address: contracts ("C…") and accounts ("G…") live
 * under different paths. Returns null for anything else, so the UI shows the
 * address without offering a link that would 404.
 */
export function explorerAddressUrl(
  address: string | null | undefined,
  network: VeilNetwork = getNetwork()
): string | null {
  const trimmed = address?.trim();
  if (!trimmed || trimmed.length !== 56) return null;

  const path = trimmed.startsWith('C') ? 'contract' : trimmed.startsWith('G') ? 'account' : null;
  if (!path) return null;

  return `https://stellar.expert/explorer/${explorerNetworkSegment(network.name)}/${path}/${trimmed}`;
}

/**
 * Explorer URL for a transaction hash. Stellar transaction hashes are 32 bytes
 * rendered as 64 hex characters; anything else returns null so the UI shows the
 * hash without offering a link that would 404.
 *
 * The network segment comes from the active network rather than a constant —
 * the app is dual-network at runtime, and a mainnet hash looked up on testnet
 * reads as "this transaction does not exist".
 */
export function explorerTxUrl(
  hash: string | null | undefined,
  network: VeilNetwork = getNetwork()
): string | null {
  const trimmed = hash?.trim();
  if (!trimmed || !/^[0-9a-fA-F]{64}$/.test(trimmed)) return null;

  return `https://stellar.expert/explorer/${explorerNetworkSegment(network.name)}/tx/${trimmed.toLowerCase()}`;
}

export type ExternalLink = {
  key: string;
  label: string;
  description: string;
  url: string;
};

/** Support surface — docs, source, and where to report problems. */
export const EXTERNAL_LINKS: readonly ExternalLink[] = [
  {
    key: 'docs',
    label: 'Documentation',
    description: 'Guides, architecture, and the SDK reference',
    url: 'https://docs.useveilapp.xyz',
  },
  {
    key: 'source',
    label: 'Source code',
    description: 'Contracts, SDK, and apps on GitHub',
    url: 'https://github.com/Miracle656/veil',
  },
  {
    key: 'issues',
    label: 'Report a problem',
    description: 'Open an issue with the maintainers',
    url: 'https://github.com/Miracle656/veil/issues/new/choose',
  },
  {
    key: 'security',
    label: 'Security policy',
    description: 'How to report a vulnerability privately',
    url: 'https://github.com/Miracle656/veil/security/policy',
  },
  {
    key: 'license',
    label: 'License',
    description: 'MIT, including third-party notices',
    url: 'https://github.com/Miracle656/veil/blob/main/LICENSE',
  },
] as const;

/**
 * Open a URL outside the app.
 *
 * Only `https` is followed: these URLs are the app's own constants today, but a
 * link surface that will accept any scheme is one contract-supplied string away
 * from opening something it should not.
 *
 * An in-app browser tab keeps the user in the app and, unlike a handoff to the
 * system browser, cannot be mistaken for the wallet itself. Where that is
 * unavailable (web), it falls back to the platform's own handling.
 *
 * @returns false when the URL was rejected or nothing could open it.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!url.startsWith('https://')) return false;

  try {
    await WebBrowser.openBrowserAsync(url);
    return true;
  } catch {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      return false;
    }
  }
}
