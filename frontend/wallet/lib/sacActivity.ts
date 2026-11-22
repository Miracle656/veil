/**
 * Reads Stellar Asset Contract (SAC) `transfer` events for a wallet's addresses
 * directly from Soroban RPC.
 *
 * Horizon's operations feed for the spending account (G address) only includes
 * transactions the spending account paid for. A transfer sent by someone else
 * straight to the wallet contract (C address) is not in that feed.
 *
 * This is the web counterpart of `loadContractSacActivity` in
 * `frontend/mobile/lib/horizonActivity.ts`. It scans frugally:
 * - Mainnet RPCs reject wide `getEvents` windows, so scans run in small chunks.
 * - A full back-scan runs once per session; later refreshes only scan the new
 *   ledgers closed since the last successful scan (1-2 RPC requests at steady
 *   state).
 * - If a scan fails or is rate-limited, cached rows are kept and `lastLedger`
 *   does not advance so the next refresh retries the same span.
 */
import { Address, Asset, scValToNative, xdr, rpc as SorobanRpc } from '@stellar/stellar-sdk'
import type { TxRecord } from '@/components/TxDetailSheet'
import { ASSET_REGISTRY, KNOWN_SAC_CONTRACT_IDS } from './assets'
import { NETWORKS, getNetwork, getNetworkName, type VeilNetworkName } from './network'

const CHUNK = 2_900 // ~4h of ledgers, under mainnet RPC processing caps
const BACKSCAN_CHUNKS = 3 // ~12h initial lookback
const MAX_CACHED = 50
const MAX_PAGES_PER_WINDOW = 4

/** Minimal RPC surface needed for event scanning (allows test injection). */
export interface SacRpcClient {
  getLatestLedger: () => Promise<{ sequence: number }>
  getEvents: (
    request: SorobanRpc.Server.GetEventsRequest,
  ) => Promise<{ events: SorobanRpc.Api.EventResponse[]; cursor?: string }>
}

const sacScan: { key: string; lastLedger: number; records: TxRecord[] } = {
  key: '',
  lastLedger: 0,
  records: [],
}

/** Clear the module-level scan cache (for tests). */
export function resetSacActivityCache(): void {
  sacScan.key = ''
  sacScan.lastLedger = 0
  sacScan.records = []
}

/**
 * Resolve a SAC contract ID to its verified asset code on the given network.
 *
 * Checks the native XLM SAC first, then the wallet's verified asset registry.
 * Unknown contract IDs are returned as-is — never defaulted to "XLM".
 */
export function assetFromContractId(
  contractId: string | null | undefined,
  network: VeilNetworkName = getNetworkName(),
): string {
  if (!contractId) return 'unknown'
  if (contractId === Asset.native().contractId(NETWORKS[network].networkPassphrase)) return 'XLM'

  const known = KNOWN_SAC_CONTRACT_IDS[network]
  for (const [code, sac] of Object.entries(known)) {
    if (sac === contractId) return code
  }

  for (const asset of Object.values(ASSET_REGISTRY)) {
    if (asset.sacContractId === contractId && (asset.network === 'all' || asset.network === network)) {
      return asset.code
    }
  }

  return contractId
}

/**
 * Extract the asset code from a SAC `transfer` event's fourth topic.
 *
 * The Stellar Asset Contract emits `"native"` for XLM and `"CODE:ISSUER"` for
 * an issued asset. Falls back to `"XLM"` when the topic is absent (older events).
 */
export function assetFromTopic(topic: unknown): string {
  if (!topic) return 'XLM'
  try {
    const raw = String(scValToNative(topic as xdr.ScVal))
    if (!raw || raw === 'native') return 'XLM'
    const code = raw.split(':')[0]
    return code && code.length > 0 ? code : 'XLM'
  } catch {
    return 'XLM'
  }
}

/**
 * Map raw Soroban SAC `transfer` events into web history rows.
 *
 * Transfers between two addresses that both belong to this wallet, or neither,
 * are ignored.
 */
export function mapSacTransferEvents(
  events: SorobanRpc.Api.EventResponse[],
  mine: Iterable<string>,
  network: VeilNetworkName = getNetworkName(),
): TxRecord[] {
  const ours = new Set([...mine].filter(Boolean))
  const rows: TxRecord[] = []

  for (const ev of events) {
    try {
      const topic = ev.topic
      if (!topic || topic.length < 3) continue
      const from = String(scValToNative(topic[1]))
      const to = String(scValToNative(topic[2]))
      const fromOurs = ours.has(from)
      const toOurs = ours.has(to)
      if (fromOurs === toOurs) continue

      const stroops = scValToNative(ev.value) as bigint | number
      const amount = (Math.abs(Number(stroops)) / 10_000_000).toFixed(7)
      const contractId =
        typeof ev.contractId === 'string'
          ? ev.contractId
          : ev.contractId?.contractId()
      const asset = topic[3]
        ? assetFromTopic(topic[3])
        : contractId
          ? assetFromContractId(contractId, network)
          : 'XLM'
      const ms = ev.ledgerClosedAt ? new Date(ev.ledgerClosedAt).getTime() : NaN
      const timestamp = Number.isFinite(ms) ? Math.floor(ms / 1000) : 0

      rows.push({
        id: ev.id,
        type: fromOurs ? 'sent' : 'received',
        amount,
        asset,
        counterparty: fromOurs ? to : from,
        timestamp,
        hash: ev.txHash,
      })
    } catch {
      // skip malformed event
    }
  }

  return rows
}

/** Scan one [startLedger, endLedger] window, following the cursor up to 4 pages. */
async function scanWindow(
  server: SacRpcClient,
  filters: SorobanRpc.Server.GetEventsRequest['filters'],
  startLedger: number,
  endLedger: number,
): Promise<SorobanRpc.Api.EventResponse[]> {
  const events: SorobanRpc.Api.EventResponse[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES_PER_WINDOW; page++) {
    const res = await server.getEvents(
      cursor
        ? { cursor, filters, limit: 100 }
        : { startLedger, endLedger, filters, limit: 100 },
    )
    events.push(...res.events)
    cursor = res.cursor
    if (!cursor) break
  }
  return events
}

/**
 * Load recent SAC `transfer` events involving any of `addresses`.
 *
 * Uses the active network's Soroban RPC unless a custom `server` is provided.
 * Never logs the RPC URL.
 */
export async function loadContractSacActivity(
  addresses: string[],
  limit = MAX_CACHED,
  options: { server?: SacRpcClient; network?: VeilNetworkName } = {},
): Promise<TxRecord[]> {
  const cleanAddresses = [...new Set(addresses.filter(Boolean))]
  if (cleanAddresses.length === 0) return []

  const net = getNetwork()
  const networkName = options.network ?? net.name
  const key = `${networkName}|${[...cleanAddresses].sort().join(',')}`
  const cached = sacScan.key === key ? sacScan : null

  try {
    const server: SacRpcClient = options.server ?? new SorobanRpc.Server(net.rpcUrl)
    const latest = await server.getLatestLedger()

    const transferSym = xdr.ScVal.scvSymbol('transfer').toXDR('base64')
    const topics = cleanAddresses.flatMap((addr) => {
      const scv = xdr.ScVal.scvAddress(new Address(addr).toScAddress()).toXDR('base64')
      return [
        [transferSym, scv, '*', '*'],
        [transferSym, '*', scv, '*'],
      ]
    })
    const filters: SorobanRpc.Server.GetEventsRequest['filters'] = [
      { type: 'contract', topics },
    ]

    const events: SorobanRpc.Api.EventResponse[] = []
    const incremental =
      !!cached && cached.lastLedger > 0 && latest.sequence - cached.lastLedger < CHUNK

    if (incremental) {
      if (latest.sequence > cached.lastLedger) {
        // One small window since the last scan; on failure keep the cache and
        // do not advance lastLedger so the next poll retries the same span.
        try {
          events.push(
            ...(await scanWindow(server, filters, cached.lastLedger + 1, latest.sequence)),
          )
        } catch {
          return cached.records.slice(0, limit)
        }
      }
    } else {
      // Full back-scan, newest chunk first so partial coverage keeps the most
      // recent activity. A failed chunk retries once at half width, then concedes.
      for (let c = 0; c < BACKSCAN_CHUNKS; c++) {
        const endLedger = latest.sequence - c * CHUNK
        for (const width of [CHUNK, Math.floor(CHUNK / 2)]) {
          try {
            events.push(
              ...(await scanWindow(
                server,
                filters,
                Math.max(1, endLedger - width + 1),
                endLedger,
              )),
            )
            break
          } catch {
            // fall through to the narrower width, or concede the chunk
          }
        }
        if (endLedger - CHUNK + 1 <= 1) break
      }
    }

    const fresh = mapSacTransferEvents(events, cleanAddresses, networkName)

    const seen = new Set<string>()
    const merged: TxRecord[] = []
    for (const r of [...fresh, ...(incremental && cached ? cached.records : [])]) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      merged.push(r)
    }
    merged.sort((a, b) => b.timestamp - a.timestamp)

    sacScan.key = key
    sacScan.lastLedger = latest.sequence
    sacScan.records = merged.slice(0, MAX_CACHED)
    return sacScan.records.slice(0, limit)
  } catch {
    return cached ? cached.records.slice(0, limit) : []
  }
}
