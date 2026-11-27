import { getRegisteredAsset, isRegisteredIssuer, USDT0_MAINNET_ISSUER } from './assets.js'
import { getBalances } from './txBuilder.js'
import { getPrice } from './price.js'
import { NETWORK, type StellarNetwork } from './network.js'

export type PortfolioAssetKind = 'cash' | 'lending' | 'invest'
export type PortfolioVerification = 'native' | 'verified' | 'unverified'

export interface PortfolioAssetLine {
  code: string
  asset: string
  issuer: string | null
  location: string
  kind: PortfolioAssetKind
  verification: PortfolioVerification
  amount: string
  priceUsd: number | null
  valueUsd: number | null
  status: 'priced' | 'unavailable' | 'unresolved'
}

export interface InFlightTransfer {
  type: string
  amount: string
  asset: string
  counterparty: string
  hash?: string
  status: 'in_flight'
}

export interface BlendPositionItem {
  poolId: string
  asset: string
  assetCode?: string
  deposited: string
  bTokenBalance?: string
}

export interface PortfolioSummaryResult {
  totalUsd: number | null
  cashUsd: number | null
  lendingUsd: number | null
  investUsd: number | null
  lines: PortfolioAssetLine[]
  inFlight: InFlightTransfer[]
  missingComponents: string[]
  summarySentence: string
}

export interface PortfolioLoaders {
  getBalances?: (feePayerAddress: string, contractAddress?: string) => Promise<Record<string, string>>
  loadBlendPositions?: (userAddress: string) => Promise<BlendPositionItem[]>
  getPrice?: (from: string, to: string) => Promise<{ price: number }>
  getInFlight?: (address: string) => Promise<InFlightTransfer[]>
}

export function classifyPortfolioKind(
  code: string,
  issuer: string | null | undefined,
  network: StellarNetwork = NETWORK,
): { kind: PortfolioAssetKind; verification: PortfolioVerification; location: string } {
  if (!issuer) {
    if (code.toUpperCase() === 'XLM') {
      return { kind: 'cash', verification: 'native', location: 'wallet' }
    }
    return { kind: 'invest', verification: 'unverified', location: 'wallet' }
  }

  const upperCode = code.toUpperCase()
  if (upperCode === 'USDT0') {
    if (issuer === USDT0_MAINNET_ISSUER) {
      return { kind: 'cash', verification: 'verified', location: 'wallet' }
    }
    return { kind: 'invest', verification: 'unverified', location: 'wallet' }
  }

  const reg = getRegisteredAsset(code)
  if (reg && isRegisteredIssuer(code, issuer)) {
    if (reg.kind === 'stablecoin') {
      return { kind: 'cash', verification: 'verified', location: 'wallet' }
    }
    return { kind: 'invest', verification: 'verified', location: 'invest' }
  }

  return { kind: 'invest', verification: 'unverified', location: 'wallet' }
}

export async function fetchPortfolioSummary(
  feePayerAddress: string,
  walletAddress?: string,
  loaders: PortfolioLoaders = {},
  network: StellarNetwork = NETWORK,
): Promise<PortfolioSummaryResult> {
  const missingComponents: string[] = []
  const lines: PortfolioAssetLine[] = []

  const balancesFn = loaders.getBalances ?? getBalances
  const priceFn = loaders.getPrice ?? getPrice
  const blendFn = loaders.loadBlendPositions ?? (async () => {
    // Default Blend loader: if not injected, Blend is unreachable unless mock/sdk is present
    throw new Error('Blend service unreachable')
  })
  const inFlightFn = loaders.getInFlight ?? (async () => [])

  // 1. Balances
  let balances: Record<string, string> = {}
  try {
    const targetContract = walletAddress?.startsWith('C') ? walletAddress : undefined
    balances = await Promise.race([
      balancesFn(feePayerAddress, targetContract),
      new Promise<Record<string, string>>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Horizon balance timeout')), 5000)
        timer.unref?.()
      }),
    ])
  } catch (err) {
    missingComponents.push('Wallet balances (Horizon unavailable)')
  }

  // 2. Blend lending positions
  let blendPositions: BlendPositionItem[] = []
  const blendTarget = walletAddress || feePayerAddress
  if (blendTarget) {
    try {
      blendPositions = await blendFn(blendTarget)
    } catch (err) {
      missingComponents.push('Blend, which I could not reach')
    }
  }

  // 3. In-flight transfers
  let inFlight: InFlightTransfer[] = []
  try {
    inFlight = await inFlightFn(blendTarget)
  } catch (err) {
    missingComponents.push('In-flight transfers (Wraith unavailable)')
  }

  // Process wallet balances
  for (const [key, amountStr] of Object.entries(balances)) {
    if (key === 'XLM_feepayer' || key === 'XLM_contract') continue
    const amountNum = parseFloat(amountStr)
    if (!isFinite(amountNum) || amountNum <= 0) continue

    let code = key
    let issuer: string | null = null
    const colonIdx = key.indexOf(':')
    if (colonIdx !== -1) {
      code = key.slice(0, colonIdx)
      issuer = key.slice(colonIdx + 1)
    } else if (code.toUpperCase() === 'XLM') {
      issuer = null
    } else {
      const reg = getRegisteredAsset(code)
      if (reg) {
        issuer = reg.issuer
      }
    }

    const { kind, verification, location } = classifyPortfolioKind(code, issuer, network)

    let priceUsd: number | null = null
    let status: 'priced' | 'unavailable' | 'unresolved' = 'unavailable'
    try {
      if (code.toUpperCase() === 'USDC' || (code.toUpperCase() === 'USDT0' && issuer === USDT0_MAINNET_ISSUER)) {
        priceUsd = 1.0
        status = 'priced'
      } else {
        const assetQuery = issuer ? `${code}:${issuer}` : code
        const p = await priceFn(assetQuery, 'USDC')
        if (p && typeof p.price === 'number' && !isNaN(p.price) && p.price > 0) {
          priceUsd = p.price
          status = 'priced'
        }
      }
    } catch {
      status = 'unavailable'
    }

    const valueUsd = priceUsd !== null ? amountNum * priceUsd : null

    lines.push({
      code,
      asset: code,
      issuer,
      location,
      kind,
      verification,
      amount: amountStr,
      priceUsd,
      valueUsd,
      status,
    })
  }

  // Process Blend lending positions
  for (const pos of blendPositions) {
    const rawStroops = BigInt(pos.deposited || '0')
    if (rawStroops <= 0n) continue

    const amountNum = Number(rawStroops) / 10_000_000
    const amountStr = amountNum.toFixed(7)
    const code = pos.assetCode ?? (pos.asset.length > 12 ? `${pos.asset.slice(0, 6)}…${pos.asset.slice(-4)}` : pos.asset)
    const issuer = pos.asset

    let priceUsd: number | null = null
    let status: 'priced' | 'unavailable' | 'unresolved' = 'unavailable'
    if (code.toUpperCase() === 'USDC') {
      priceUsd = 1.0
      status = 'priced'
    } else {
      try {
        const p = await priceFn(code, 'USDC')
        if (p && typeof p.price === 'number' && p.price > 0) {
          priceUsd = p.price
          status = 'priced'
        }
      } catch {
        status = 'unavailable'
      }
    }

    const valueUsd = priceUsd !== null ? amountNum * priceUsd : null

    lines.push({
      code,
      asset: code,
      issuer,
      location: 'Blend lending',
      kind: 'lending',
      verification: 'verified',
      amount: amountStr,
      priceUsd,
      valueUsd,
      status,
    })
  }

  // Calculate totals
  const pricedLines = lines.filter((l) => l.valueUsd !== null)
  const totalUsd = pricedLines.length > 0
    ? pricedLines.reduce((sum, l) => sum + (l.valueUsd as number), 0)
    : null

  const cashLines = pricedLines.filter((l) => l.kind === 'cash')
  const cashUsd = cashLines.length > 0 ? cashLines.reduce((s, l) => s + (l.valueUsd as number), 0) : null

  const lendingLines = pricedLines.filter((l) => l.kind === 'lending')
  const lendingUsd = lendingLines.length > 0 ? lendingLines.reduce((s, l) => s + (l.valueUsd as number), 0) : null

  const investLines = pricedLines.filter((l) => l.kind === 'invest')
  const investUsd = investLines.length > 0 ? investLines.reduce((s, l) => s + (l.valueUsd as number), 0) : null

  // Format one-sentence honest answer
  let summarySentence = ''
  const exclusionSuffix = missingComponents.length > 0
    ? ` (excluding ${missingComponents.map((c) => c.replace(/\s*\(.*\)/, '').replace(/, which I could not reach/, '')).join(' and ')}, which I could not reach)`
    : ''

  if (totalUsd !== null) {
    const parts: string[] = []
    if (cashUsd !== null && cashUsd > 0) parts.push(`$${cashUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} in cash`)
    if (lendingUsd !== null && lendingUsd > 0) parts.push(`$${lendingUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} in Blend lending`)
    if (investUsd !== null && investUsd > 0) parts.push(`$${investUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} in invest holdings`)

    const breakdown = parts.length > 1 ? ` (${parts.join(', ')})` : ''
    summarySentence = `You have $${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} total${breakdown}${exclusionSuffix}.`
  } else if (lines.length > 0) {
    summarySentence = `You have ${lines.map((l) => `${l.amount} ${l.code}`).join(', ')}, but total USD value cannot be fully calculated${exclusionSuffix}.`
  } else {
    summarySentence = `You currently have no recorded balances or positions${exclusionSuffix}.`
  }

  return {
    totalUsd,
    cashUsd,
    lendingUsd,
    investUsd,
    lines,
    inFlight,
    missingComponents,
    summarySentence,
  }
}
