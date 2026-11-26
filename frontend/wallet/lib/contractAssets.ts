/**
 * The wallet contract's own token balances.
 *
 * A Veil wallet keeps money in two places: the `C…` contract, which is the
 * wallet proper, and the `G…` fee-payer that pays network fees. The dashboard
 * summed XLM across both but listed every other asset from the fee-payer
 * alone, so a balance held by the contract simply did not appear.
 *
 * That is not a cosmetic gap. `register` on the names registry spends from the
 * contract, so somebody could hold plenty of USDC, see it on the dashboard,
 * and be told they could not afford a 3 USDC name — with nothing on screen to
 * explain the contradiction.
 *
 * Horizon cannot answer this: a `C…` address has no account entry and no
 * trustlines. Each asset's balance lives inside its Stellar Asset Contract, so
 * it has to be read one SAC at a time.
 */

import {
  Account,
  Asset,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
} from '@stellar/stellar-sdk'

import { inclusionFee } from './fees'
import { getNetwork, getUsdcIssuer } from './network'
import type { WalletAsset } from './walletTypes'

/** Assets worth checking even when the fee-payer holds none of them. */
function baselineAssets(): { code: string; issuer: string }[] {
  return [{ code: 'USDC', issuer: getUsdcIssuer() }]
}

/** One SAC `balance` read. Null on any failure — never a fabricated zero. */
async function sacBalance(
  rpc: SorobanRpc.Server,
  sacId: string,
  address: string,
  networkPassphrase: string,
): Promise<bigint | null> {
  try {
    const tx = new TransactionBuilder(new Account(Keypair.random().publicKey(), '0'), {
      fee: inclusionFee(),
      networkPassphrase,
    })
      .addOperation(new Contract(sacId).call('balance', nativeToScVal(address, { type: 'address' })))
      .setTimeout(30)
      .build()

    const sim = await rpc.simulateTransaction(tx)
    if (SorobanRpc.Api.isSimulationError(sim)) return null
    const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
    if (!result?.retval) return null
    const value = scValToNative(result.retval)
    return typeof value === 'bigint' ? value : null
  } catch {
    return null
  }
}

/**
 * Read the contract's balance for every asset worth asking about: the ones the
 * fee-payer already holds, plus USDC, which is what names are paid in and so
 * must be visible even when the fee-payer has none.
 *
 * Only non-zero balances are returned — the caller sums these into whatever
 * the fee-payer reported.
 */
export async function readContractAssetBalances(
  walletAddress: string,
  feePayerAssets: WalletAsset[],
): Promise<WalletAsset[]> {
  if (!walletAddress) return []

  const wanted = new Map<string, { code: string; issuer: string }>()
  for (const a of feePayerAssets) {
    if (a.issuer) wanted.set(`${a.code}:${a.issuer}`, { code: a.code, issuer: a.issuer })
  }
  for (const a of baselineAssets()) wanted.set(`${a.code}:${a.issuer}`, a)
  if (wanted.size === 0) return []

  const net = getNetwork()
  const rpc = new SorobanRpc.Server(net.rpcUrl)

  const results: (WalletAsset | null)[] = await Promise.all(
    [...wanted.values()].map(async ({ code, issuer }) => {
      let sacId: string
      try {
        sacId = new Asset(code, issuer).contractId(net.networkPassphrase)
      } catch {
        return null
      }
      const stroops = await sacBalance(rpc, sacId, walletAddress, net.networkPassphrase)
      if (stroops === null || stroops <= 0n) return null
      const asset: WalletAsset = {
        code,
        issuer,
        balance: (Number(stroops) / 10_000_000).toFixed(7),
      }
      return asset
    }),
  )

  return results.filter((a): a is WalletAsset => a !== null)
}

/**
 * Sum two balance lists by `code:issuer`.
 *
 * Both accounts are the user's, and the dashboard already treats them as one
 * for XLM. Showing a single figure per asset keeps that promise; the names
 * flow is what knows the difference, because it is the only place it matters.
 */
export function mergeAssetBalances(
  feePayerAssets: WalletAsset[],
  contractAssets: WalletAsset[],
): WalletAsset[] {
  const byKey = new Map<string, WalletAsset>()

  for (const a of [...feePayerAssets, ...contractAssets]) {
    const key = `${a.code}:${a.issuer ?? ''}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...a })
      continue
    }
    const sum = parseFloat(existing.balance) + parseFloat(a.balance)
    byKey.set(key, { ...existing, balance: sum.toFixed(7) })
  }

  return [...byKey.values()]
}
