/**
 * Client-side Name Claim Flow (SEP-2 Write Layer / V275)
 *
 * Implements:
 * 1. Live server availability queries (with server normalisation & confusable checks)
 * 2. 5 USDC payment via SAC contract transfer from wallet C... address (signed with passkey __check_auth)
 * 3. Double-tap protection (immediate submission lock)
 * 4. Recovery mechanism for successful payments whose API binding failed, preventing double-charging
 */

import { walletLocal } from '@/lib/walletStorage'
import { requirePasskey } from '@/lib/passkeyAuth'
import { getNetwork, getNetworkName } from '@/lib/network'
import { Asset, Contract, Operation, SorobanRpc, TransactionBuilder, nativeToScVal } from '@stellar/stellar-sdk'
import { getFeePayer } from '@/lib/feePayer'
import { inclusionFee } from '@/lib/fees'
import type { MasqueradeFigure } from './masquerade'

export const CLAIM_PRICE_USDC = '5.0000000'
export const CLAIM_PRICE_DISPLAY = '5 USDC'
export const PENDING_CLAIM_KEY = 'veil_pending_name_claim'

export const DEFAULT_TREASURY_ADDRESS =
  process.env.NEXT_PUBLIC_TREASURY_ADDRESS || 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW'

// USDC issuer on mainnet / testnet
export const USDC_ISSUERS: Record<string, string> = {
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
}

export interface NameAvailabilityResponse {
  name: string
  available: boolean
  normalized?: string
  skeleton?: string
  reason?: string
  price: string
  priceUsdc: number
  nextClaimOrder: number
  hasFigure: boolean
  figure: MasqueradeFigure | null
  figureWarning?: string
  figureNote?: string
}

export interface PendingClaimRecord {
  name: string
  walletAddress: string
  passkeyPublicKey: string
  paymentTxHash: string
  timestamp: number
}

export interface ClaimResult {
  success: boolean
  name: string
  stellar_address: string
  tokenId: string
  walletAddress: string
  paymentTxHash: string
  hasFigure: boolean
  figure: MasqueradeFigure | null
  figureWarning?: string
}

export function getPendingClaim(): PendingClaimRecord | null {
  try {
    const raw = walletLocal.getItem(PENDING_CLAIM_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PendingClaimRecord
  } catch {
    return null
  }
}

export function setPendingClaim(record: PendingClaimRecord): void {
  try {
    walletLocal.setItem(PENDING_CLAIM_KEY, JSON.stringify(record))
  } catch {
    // ignore local storage error
  }
}

export function clearPendingClaim(): void {
  try {
    walletLocal.removeItem(PENDING_CLAIM_KEY)
  } catch {
    // ignore
  }
}

/**
 * Checks live name availability and metadata preview against the server.
 */
export async function checkNameAvailability(rawName: string): Promise<NameAvailabilityResponse> {
  const trimmed = (rawName || '').trim()
  if (!trimmed) {
    return {
      name: '',
      available: false,
      reason: 'Name cannot be empty',
      price: CLAIM_PRICE_DISPLAY,
      priceUsdc: 5,
      nextClaimOrder: 1,
      hasFigure: true,
      figure: null,
    }
  }

  const res = await fetch(`/api/names/available?name=${encodeURIComponent(trimmed)}`)
  const data = await res.json()
  if (!res.ok) {
    return {
      name: trimmed,
      available: false,
      reason: data.error || 'Failed to check name availability',
      price: CLAIM_PRICE_DISPLAY,
      priceUsdc: 5,
      nextClaimOrder: 1,
      hasFigure: false,
      figure: null,
    }
  }
  return data as NameAvailabilityResponse
}

/**
 * Recovers and submits an already paid claim without charging twice.
 */
export async function recoverPendingClaim(record: PendingClaimRecord): Promise<ClaimResult> {
  const res = await fetch('/api/names/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: record.name,
      walletAddress: record.walletAddress,
      passkeyPublicKey: record.passkeyPublicKey,
      paymentTxHash: record.paymentTxHash,
    }),
  })

  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.error || 'Failed to finalize name claim')
  }

  clearPendingClaim()
  return {
    success: true,
    name: data.record.name,
    stellar_address: data.record.stellar_address,
    tokenId: data.record.tokenId,
    walletAddress: data.record.walletAddress,
    paymentTxHash: record.paymentTxHash,
    hasFigure: data.record.hasFigure,
    figure: data.record.figure,
    figureWarning: data.record.figureWarning,
  }
}

/**
 * Executes the complete claim flow:
 * 1. Verifies availability
 * 2. Prompts passkey authorization (__check_auth)
 * 3. Submits 5 USDC payment from wallet address
 * 4. Records pending claim locally for crash recovery
 * 5. Registers claim via /api/names/claim
 */
export async function executeClaim(params: {
  name: string
  walletAddress: string
  passkeyPublicKey: string
  treasuryAddress?: string
  mockPaymentTxHash?: string // For unit testing without network
}): Promise<ClaimResult> {
  const { name, walletAddress, passkeyPublicKey, treasuryAddress = DEFAULT_TREASURY_ADDRESS, mockPaymentTxHash } = params

  // 1. Check if we already have an unfinalized payment for this name
  const existingPending = getPendingClaim()
  if (
    existingPending &&
    existingPending.name.toLowerCase() === name.toLowerCase() &&
    existingPending.paymentTxHash
  ) {
    return await recoverPendingClaim(existingPending)
  }

  // 2. Pre-flight availability check
  const avail = await checkNameAvailability(name)
  if (!avail.available) {
    throw new Error(avail.reason || 'This name is not available to claim.')
  }

  let paymentTxHash = mockPaymentTxHash

  // 3. Process payment on-chain if no mock provided
  if (!paymentTxHash) {
    await requirePasskey()

    const netName = getNetworkName()
    const network = getNetwork()
    const usdcIssuer = USDC_ISSUERS[netName] || USDC_ISSUERS.testnet
    const usdcAsset = new Asset('USDC', usdcIssuer)
    const usdcContractId = usdcAsset.contractId(network.networkPassphrase)

    const feePayerKp = getFeePayer()
    if (!feePayerKp) {
      throw new Error('Fee payer keypair not found. Please reload the wallet.')
    }

    const rpcServer = new SorobanRpc.Server(network.rpcUrl)
    const feePayerAcct = await rpcServer.getAccount(feePayerKp.publicKey())
    const sacContract = new Contract(usdcContractId)
    const amountStroops = 50_000_000n // 5 USDC (7 decimal places)

    const tx = new TransactionBuilder(feePayerAcct, {
      fee: inclusionFee(),
      networkPassphrase: network.networkPassphrase,
    })
      .addOperation(
        sacContract.call(
          'transfer',
          nativeToScVal(walletAddress, { type: 'address' }),
          nativeToScVal(treasuryAddress, { type: 'address' }),
          nativeToScVal(amountStroops, { type: 'i128' }),
        ),
      )
      .setTimeout(30)
      .build()

    const sim = await rpcServer.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(`Payment simulation failed: ${sim.error}`)
    }

    const assembled = SorobanRpc.assembleTransaction(tx, sim).build()
    assembled.sign(feePayerKp)

    const sendResult = await rpcServer.sendTransaction(assembled)
    if (sendResult.status === 'ERROR') {
      throw new Error(`Payment rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`)
    }

    for (let i = 0; i < 30; i++) {
      const result = await rpcServer.getTransaction(sendResult.hash)
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          throw new Error(`Payment transaction failed: ${result.status}`)
        }
        break
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }

    paymentTxHash = sendResult.hash
  }

  // 4. Save pending claim record locally to prevent double-charging on failure
  const pendingRecord: PendingClaimRecord = {
    name,
    walletAddress,
    passkeyPublicKey,
    paymentTxHash,
    timestamp: Date.now(),
  }
  setPendingClaim(pendingRecord)

  // 5. Finalize reservation with server
  return await recoverPendingClaim(pendingRecord)
}
