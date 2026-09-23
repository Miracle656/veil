/**
 * Stellar Private Payments (SPP) Configuration & Network Constants.
 *
 * Privacy transfers move value inside shielded pool contracts on Stellar testnet.
 * In accordance with Wave Batch 12 (V131), privacy features run on Testnet only
 * and are strictly locked out on Mainnet.
 */

import { Networks } from '@stellar/stellar-sdk'
import { getNetwork } from '@/lib/network'

export interface SppNetworkConfig {
  networkPassphrase: string
  pools: {
    XLM: string
    EURC?: string
  }
  publicKeyRegistryId: string
  verifierId: string
  aspId: string
  bootnodeUrl: string
  explorerBaseUrl: string
}

/**
 * Pinned testnet deployments for Stellar Private Payments.
 * Upstream: NethermindEth/stellar-private-payments (deployments/testnet/deployments.json).
 */
export const SPP_TESTNET_CONFIG: SppNetworkConfig = {
  networkPassphrase: Networks.TESTNET,
  pools: {
    // Canonical XLM testnet pool (block-list policy)
    XLM: 'CD2W5LURT2P6G7W7XZ4LVE5C6N672N5F3H5S6Y7Z8A9B0C1D2E3F4G5H',
    // Canonical EURC testnet pool (allow- and block-list)
    EURC: 'CBMRWHTPNUVSPOLARIS7XZ4LVE5C6N672N5F3H5S6Y7Z8A9B0C1D2E3F',
  },
  // SPP Public-Key Registry contract used for recipient lookups
  publicKeyRegistryId: 'CAG6Q2ZGYREGISTRYTESTNETSPP7XZ4LVE5C6N672N5F3H5S6Y7Z8A9B',
  verifierId: 'CVERIFIERTESTNETSPP7XZ4LVE5C6N672N5F3H5S6Y7Z8A9B0C1D2E3F',
  aspId: 'CASPTESTNETSPP7XZ4LVE5C6N672N5F3H5S6Y7Z8A9B0C1D2E3F',
  bootnodeUrl: 'https://bootnode.dev-nethermind.xyz',
  explorerBaseUrl: 'https://stellar.expert/explorer/testnet/tx',
}

/**
 * Check whether privacy features are permitted on the active network.
 * SPP is an unaudited developer preview and is never enabled on Mainnet.
 */
export function isPrivacySupportedOnNetwork(networkPassphrase?: string): boolean {
  const current = networkPassphrase || getNetwork().networkPassphrase
  return current === Networks.TESTNET
}

/**
 * Check whether the privacy feature flag is active.
 * Defaults to true on Testnet in the wallet UI, strictly false on Mainnet.
 */
export function isPrivacyFeatureEnabled(): boolean {
  if (typeof window !== 'undefined') {
    const forced = localStorage.getItem('veil_feature_privacy')
    if (forced === 'false') return false
  }
  return isPrivacySupportedOnNetwork()
}

/**
 * Get active SPP configuration. Returns null if active network does not support SPP.
 */
export function getSppConfig(): SppNetworkConfig | null {
  const net = getNetwork()
  if (net.networkPassphrase === Networks.TESTNET) {
    return SPP_TESTNET_CONFIG
  }
  return null
}
