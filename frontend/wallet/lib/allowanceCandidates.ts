import { KNOWN_SAC_CONTRACT_IDS } from './assets'
import { configuredPoolIds } from './blend'
import { getNativeAssetContractId, getNetworkName } from './network'
import { getSppConfig } from './privacy/config'
import type { AllowancePair } from './allowances'

/** A token an allowance can be held on. Every one listed here is a SAC (7 decimals). */
export interface KnownToken {
  contractId: string
  code: string
  decimals: number
}

/** A contract this wallet integrates with, and so might have been approved. */
export interface KnownSpender {
  contractId: string
  label: string
}

export function knownTokens(): KnownToken[] {
  const network = getNetworkName()
  const tokens: KnownToken[] = [{ contractId: getNativeAssetContractId(), code: 'XLM', decimals: 7 }]
  for (const [code, contractId] of Object.entries(KNOWN_SAC_CONTRACT_IDS[network] ?? {})) {
    tokens.push({ contractId, code, decimals: 7 })
  }
  return tokens
}

export function knownSpenders(): KnownSpender[] {
  const spenders: KnownSpender[] = configuredPoolIds().map((contractId) => ({
    contractId,
    label: 'Blend lending pool',
  }))
  for (const pool of getSppConfig()?.pools ?? []) {
    spenders.push({ contractId: pool.id, label: 'Privacy pool' })
  }
  return spenders
}

/** Every known spender crossed with every known token. */
export function knownCandidatePairs(): AllowancePair[] {
  const tokens = knownTokens()
  return knownSpenders().flatMap((spender) =>
    tokens.map((token) => ({ spender: spender.contractId, token: token.contractId })),
  )
}
