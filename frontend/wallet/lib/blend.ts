/**
 * blend.ts
 * Wrapper around @blend-capital/blend-sdk for pool queries and
 * supply/withdraw transaction building.
 * Used by the Earn page (issue #120).
 */

import { getNetwork } from '@/lib/network'
import { Networks } from '@stellar/stellar-sdk'

const net = getNetwork()
const IS_TESTNET = net.networkPassphrase === Networks.TESTNET

export interface BlendPool {
  id: string
  name: string
  supplyApy: number // e.g. 0.042 = 4.2%
  totalSupply: string
  assets: string[]
}

export interface BlendPosition {
  poolId: string
  asset: string
  deposited: string   // underlying amount
  bTokenBalance: string // receipt token balance
  accruedInterest: string
}

/** Load all available Blend pools and their APYs. */
export async function loadBlendPools(): Promise<BlendPool[]> {
  try {
    const { PoolFactory } = await import('@blend-capital/blend-sdk')
    const factory = new PoolFactory({
      network: IS_TESTNET ? 'testnet' : 'mainnet',
      rpcUrl: net.sorobanRpcUrl ?? net.horizonUrl,
    })
    const pools = await factory.loadPools()
    return pools.map((p: any) => ({
      id: p.id,
      name: p.name ?? p.id.slice(0, 8),
      supplyApy: p.config?.supplyApy ?? 0,
      totalSupply: p.totalSupply?.toString() ?? '0',
      assets: p.assets ?? [],
    }))
  } catch (err) {
    console.warn('[blend] loadPools failed:', err)
    return []
  }
}

/** Get the user's current deposit positions across all pools. */
export async function loadBlendPositions(
  contractAddress: string // the Veil C... wallet address
): Promise<BlendPosition[]> {
  try {
    const { BlendSDK } = await import('@blend-capital/blend-sdk')
    const sdk = new BlendSDK({
      network: IS_TESTNET ? 'testnet' : 'mainnet',
      rpcUrl: net.sorobanRpcUrl ?? net.horizonUrl,
    })
    const positions = await sdk.loadUserPositions(contractAddress)
    return (positions ?? []).map((p: any) => ({
      poolId: p.poolId,
      asset: p.asset,
      deposited: p.supplied?.toString() ?? '0',
      bTokenBalance: p.bTokenBalance?.toString() ?? '0',
      accruedInterest: p.accruedInterest?.toString() ?? '0',
    }))
  } catch (err) {
    console.warn('[blend] loadPositions failed:', err)
    return []
  }
}

interface SupplyParams {
  poolId: string
  assetContract: string
  amountInStroops: bigint
  supplierAddress: string // C... contract address
}

/** Build a Blend supply (deposit) transaction XDR. */
export async function buildBlendSupplyXdr(params: SupplyParams): Promise<string | null> {
  try {
    const { BlendSDK } = await import('@blend-capital/blend-sdk')
    const sdk = new BlendSDK({
      network: IS_TESTNET ? 'testnet' : 'mainnet',
      rpcUrl: net.sorobanRpcUrl ?? net.horizonUrl,
    })
    const tx = await sdk.buildSupplyTransaction({
      poolId: params.poolId,
      asset: params.assetContract,
      amount: params.amountInStroops,
      supplierAddress: params.supplierAddress,
    })
    return tx.toXDR()
  } catch (err) {
    console.warn('[blend] buildSupplyXdr failed:', err)
    return null
  }
}

interface WithdrawParams {
  poolId: string
  assetContract: string
  bTokenAmount: bigint
  supplierAddress: string
}

/** Build a Blend withdraw (redeem) transaction XDR. */
export async function buildBlendWithdrawXdr(params: WithdrawParams): Promise<string | null> {
  try {
    const { BlendSDK } = await import('@blend-capital/blend-sdk')
    const sdk = new BlendSDK({
      network: IS_TESTNET ? 'testnet' : 'mainnet',
      rpcUrl: net.sorobanRpcUrl ?? net.horizonUrl,
    })
    const tx = await sdk.buildWithdrawTransaction({
      poolId: params.poolId,
      asset: params.assetContract,
      bTokenAmount: params.bTokenAmount,
      supplierAddress: params.supplierAddress,
    })
    return tx.toXDR()
  } catch (err) {
    console.warn('[blend] buildWithdrawXdr failed:', err)
    return null
  }
}
