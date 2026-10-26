/**
 * @jest-environment node
 *
 * Live resample of the private-transaction costs in `docs/PRIVACY_COST.md` §2 (#1211).
 *
 * Skipped unless `SPP_COST_LIVE=1`, so `npm test` never depends on a third party
 * being up. It runs the same `samplePrivateTransactionCosts` that
 * `sponsoredSubmit.test.ts` covers against the pinned testnet pools and prints
 * the report:
 *
 *   cd frontend/wallet && SPP_COST_LIVE=1 npx jest lib/privacy/__tests__/sponsoredSubmit.live.test.ts
 *
 * Environment:
 *   SPP_COST_LIVE=1             run the sample
 *   SPP_COST_RPC_URL=<url>      RPC to read from (default: the wallet's testnet RPC)
 *   SPP_COST_START_LEDGER=<n>   first ledger to scan (default: the oldest RPC retains, ~7 days)
 *
 * It fails if the sample is incomplete, so a partial answer from RPC cannot be
 * copied into the document as if it covered the whole window. An empty window
 * passes and prints "no figure".
 */

import { rpc as SorobanRpc } from '@stellar/stellar-sdk'

import { NETWORKS } from '../../network'
import { getSppConfig } from '../config'
import { formatPoolCostReport, samplePrivateTransactionCosts } from '../sponsoredSubmit'

const live = process.env.SPP_COST_LIVE === '1'

;(live ? it : it.skip)(
  'resamples the private-transaction cost figures from the testnet pools',
  async () => {
    const rpcUrl = process.env.SPP_COST_RPC_URL?.trim() || NETWORKS.testnet.rpcUrl
    const startLedger = process.env.SPP_COST_START_LEDGER
      ? Number(process.env.SPP_COST_START_LEDGER)
      : undefined
    const pools = getSppConfig('testnet')!.pools.map((pool) => pool.id)

    const sample = await samplePrivateTransactionCosts({
      rpc: new SorobanRpc.Server(rpcUrl),
      poolContractIds: pools,
      startLedger,
    })

    console.log(`Pools: ${pools.join(', ')}\nRPC: ${rpcUrl}\n${formatPoolCostReport(sample)}`)
    expect(sample.complete).toBe(true)
  },
  10 * 60_000
)
