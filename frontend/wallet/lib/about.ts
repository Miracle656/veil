/**
 * Facts shown on the About screen: build identity, active network, and the
 * contract addresses actually in use — derived at render time so they can't
 * drift from the running build. Mirrors frontend/mobile/lib/about.ts.
 */
import { StrKey } from '@stellar/stellar-sdk'
import { getNetwork } from './network'
import { redactEndpoint } from './redactEndpoint'

export function getBuildId(): string {
  const sha = process.env.NEXT_PUBLIC_COMMIT_SHA?.trim()
  if (!sha || sha === 'dev') return 'dev'
  return sha.slice(0, 7)
}

export interface AboutFact {
  key: string
  label: string
  value: string
}

/** Network facts. RPC/Horizon URLs are redacted — never rendered with their path intact. */
export function getNetworkFacts(): AboutFact[] {
  const network = getNetwork()
  return [
    { key: 'network', label: 'Network', value: network.displayName },
    { key: 'rpc', label: 'Soroban RPC', value: redactEndpoint(network.rpcUrl) },
    { key: 'horizon', label: 'Horizon', value: redactEndpoint(network.horizonUrl) },
  ]
}

/** Contract addresses actually in use for the active network — never hardcoded in the page. */
export function getContractEntries(walletAddress: string | null): AboutFact[] {
  const network = getNetwork()
  const entries: AboutFact[] = []
  if (walletAddress && StrKey.isValidContract(walletAddress)) {
    entries.push({ key: 'wallet', label: 'Your wallet', value: walletAddress })
  }
  if (StrKey.isValidContract(network.factoryContractId)) {
    entries.push({ key: 'factory', label: 'Wallet factory', value: network.factoryContractId })
  }
  return entries
}

export interface ExternalLink {
  key: string
  label: string
  description: string
  url: string
}

export const EXTERNAL_LINKS: ExternalLink[] = [
  { key: 'docs', label: 'Documentation', description: 'Guides, architecture, and the SDK reference', url: 'https://docs.useveilapp.xyz' },
  { key: 'invest-docs', label: 'Invest rail disclosures', description: 'What tokenized assets are, issuer risks, and what Veil is not', url: 'https://docs.useveilapp.xyz/invest' },
  { key: 'source', label: 'Source code', description: 'Contracts, SDK, and apps on GitHub', url: 'https://github.com/Miracle656/veil' },
  { key: 'issues', label: 'Report a problem', description: 'Open an issue with the maintainers', url: 'https://github.com/Miracle656/veil/issues/new/choose' },
  { key: 'security', label: 'Security policy', description: 'How to report a vulnerability privately', url: 'https://github.com/Miracle656/veil/security/policy' },
  { key: 'license', label: 'License', description: 'MIT, including third-party notices', url: 'https://github.com/Miracle656/veil/blob/main/LICENSE' },
]

export function explorerNetworkSegment(): 'public' | 'testnet' {
  return getNetwork().name === 'mainnet' ? 'public' : 'testnet'
}

export function explorerAddressUrl(address: string): string | null {
  if (StrKey.isValidContract(address)) {
    return `https://stellar.expert/explorer/${explorerNetworkSegment()}/contract/${address}`
  }
  if (StrKey.isValidEd25519PublicKey(address)) {
    return `https://stellar.expert/explorer/${explorerNetworkSegment()}/account/${address}`
  }
  return null
}

export function shortAddress(address: string): string {
  if (address.length <= 16) return address
  return `${address.slice(0, 8)}…${address.slice(-6)}`
}
