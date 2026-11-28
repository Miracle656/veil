/** @jest-environment node */
import { Address, Asset, Keypair, StrKey, nativeToScVal, xdr, type rpc as SorobanRpc } from '@stellar/stellar-sdk'
import { KNOWN_SAC_CONTRACT_IDS } from '../assets'
import { NETWORKS } from '../network'
import { mergeHistory } from '../walletHistory'
import {
  assetFromContractId,
  dedupeSecondarySources,
  formatStroops,
  loadContractSacActivity,
  mapSacTransferEvents,
  resetSacActivityCache,
  type SacRpcClient,
} from '../sacActivity'

// Made-up addresses only — no real wallet or user address.
const WALLET_C = StrKey.encodeContract(Buffer.alloc(32, 1))
const SPENDING_G = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey()
const SENDER_G = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey()
const OTHER_G = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey()
const UNKNOWN_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9))
const ISSUER_G = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).publicKey()

const TESTNET_XLM_SAC = Asset.native().contractId(NETWORKS.testnet.networkPassphrase)
const TESTNET_USDC_SAC = KNOWN_SAC_CONTRACT_IDS.testnet.USDC

function makeTransferEvent(opts: {
  id: string
  from: string
  to: string
  stroops: bigint
  assetTopic?: string | null
  txHash: string
  ledgerClosedAt?: string
  contractId: string
}): SorobanRpc.Api.EventResponse {
  const topic: xdr.ScVal[] = [
    xdr.ScVal.scvSymbol('transfer'),
    new Address(opts.from).toScVal(),
    new Address(opts.to).toScVal(),
  ]
  if (opts.assetTopic !== null) {
    topic.push(nativeToScVal(opts.assetTopic ?? 'native', { type: 'string' }))
  }
  return {
    type: 'contract',
    ledger: 100_000,
    ledgerClosedAt: opts.ledgerClosedAt ?? '2026-11-20T12:00:00Z',
    contractId: opts.contractId,
    id: opts.id,
    pagingToken: opts.id,
    topic,
    value: nativeToScVal(opts.stroops, { type: 'i128' }),
    inSuccessfulContractCall: true,
    txHash: opts.txHash,
  } as unknown as SorobanRpc.Api.EventResponse
}

describe('SAC transfer event mapping', () => {
  it('maps an incoming transfer sent straight to the wallet C address using the emitting contract id', () => {
    const ev = makeTransferEvent({
      id: 'ev-1',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 125_000_000n, // 12.5 USDC
      assetTopic: `USDC:${ISSUER_G}`,
      contractId: TESTNET_USDC_SAC,
      txHash: 'tx-incoming-usdc',
      ledgerClosedAt: '2026-11-20T12:30:00Z',
    })

    const rows = mapSacTransferEvents([ev], [WALLET_C, SPENDING_G], 'testnet')
    expect(rows).toEqual([
      {
        id: 'ev-1',
        type: 'received',
        amount: '12.5000000',
        asset: 'USDC',
        counterparty: SENDER_G,
        timestamp: Math.floor(Date.parse('2026-11-20T12:30:00Z') / 1000),
        hash: 'tx-incoming-usdc',
      },
    ])
  })

  it('does not trust spoofed fourth topics from an unknown contract', () => {
    const spoofedNative = makeTransferEvent({
      id: 'ev-spoof-xlm',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 100_000_000n,
      assetTopic: 'native',
      contractId: UNKNOWN_CONTRACT,
      txHash: 'tx-spoof-xlm',
    })
    const spoofedUsdc = makeTransferEvent({
      id: 'ev-spoof-usdc',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 100_000_000n,
      assetTopic: `USDC:${ISSUER_G}`,
      contractId: UNKNOWN_CONTRACT,
      txHash: 'tx-spoof-usdc',
    })

    const rows = mapSacTransferEvents([spoofedNative, spoofedUsdc], [WALLET_C, SPENDING_G], 'testnet')
    expect(rows.map((r) => r.asset)).toEqual([UNKNOWN_CONTRACT, UNKNOWN_CONTRACT])
  })

  it('maps an outgoing native XLM transfer from the wallet C address', () => {
    const ev = makeTransferEvent({
      id: 'ev-2',
      from: WALLET_C,
      to: OTHER_G,
      stroops: 50_000_000n,
      assetTopic: 'native',
      contractId: TESTNET_XLM_SAC,
      txHash: 'tx-outgoing-xlm',
    })

    const rows = mapSacTransferEvents([ev], [WALLET_C, SPENDING_G], 'testnet')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'ev-2',
      type: 'sent',
      amount: '5.0000000',
      asset: 'XLM',
      counterparty: OTHER_G,
      hash: 'tx-outgoing-xlm',
    })
  })

  it('ignores internal transfers between the wallet C address and its spending G address', () => {
    const ev = makeTransferEvent({
      id: 'ev-internal',
      from: WALLET_C,
      to: SPENDING_G,
      stroops: 10_000_000n,
      contractId: TESTNET_XLM_SAC,
      txHash: 'tx-internal',
    })

    expect(mapSacTransferEvents([ev], [WALLET_C, SPENDING_G], 'testnet')).toEqual([])
  })

  it('ignores transfers between two unrelated addresses', () => {
    const ev = makeTransferEvent({
      id: 'ev-other',
      from: SENDER_G,
      to: OTHER_G,
      stroops: 10_000_000n,
      contractId: TESTNET_XLM_SAC,
      txHash: 'tx-other',
    })

    expect(mapSacTransferEvents([ev], [WALLET_C, SPENDING_G], 'testnet')).toEqual([])
  })
})

describe('integer stroop formatting', () => {
  it('formats exact 7-decimal amounts without floating-point precision loss', () => {
    expect(formatStroops(0n)).toBe('0.0000000')
    expect(formatStroops(1n)).toBe('0.0000001')
    expect(formatStroops(125_000_000n)).toBe('12.5000000')
    expect(formatStroops(-42_000_003n)).toBe('4.2000003')
    // Beyond Number.MAX_SAFE_INTEGER (9007199254740991)
    expect(formatStroops(123_456_789_012_345_678_901n)).toBe('12345678901234.5678901')
    expect(formatStroops('9007199254740999')).toBe('900719925.4740999')
  })

  it('returns 0.0000000 instead of throwing on malformed amounts', () => {
    expect(formatStroops('')).toBe('0.0000000')
    expect(formatStroops('NaN')).toBe('0.0000000')
    expect(formatStroops('12.34')).toBe('0.0000000')
    expect(formatStroops('not-a-number')).toBe('0.0000000')
    expect(formatStroops(Number.NaN)).toBe('0.0000000')
    expect(formatStroops(1.5)).toBe('0.0000000')
    expect(formatStroops(null)).toBe('0.0000000')
    expect(formatStroops(undefined)).toBe('0.0000000')
  })
})

describe('token lookup', () => {
  it('resolves verified contract IDs and never defaults unknown contracts to XLM', () => {
    expect(assetFromContractId(TESTNET_XLM_SAC, 'testnet')).toBe('XLM')
    expect(assetFromContractId(Asset.native().contractId(NETWORKS.mainnet.networkPassphrase), 'mainnet')).toBe('XLM')
    expect(assetFromContractId(TESTNET_USDC_SAC, 'testnet')).toBe('USDC')
    expect(assetFromContractId(KNOWN_SAC_CONTRACT_IDS.mainnet.USDC, 'mainnet')).toBe('USDC')
    expect(assetFromContractId(KNOWN_SAC_CONTRACT_IDS.mainnet.USDT0, 'mainnet')).toBe('USDT0')

    // Unknown contract ID returns the contract ID itself, never XLM
    expect(assetFromContractId(UNKNOWN_CONTRACT, 'mainnet')).toBe(UNKNOWN_CONTRACT)
    expect(assetFromContractId(UNKNOWN_CONTRACT, 'testnet')).toBe(UNKNOWN_CONTRACT)
    expect(assetFromContractId('', 'mainnet')).toBe('unknown')
    expect(assetFromContractId(null, 'mainnet')).toBe('unknown')
  })
})

describe('merging Horizon, RPC event, and indexer rows', () => {
  it('keeps the Horizon row when an event row shares its transaction hash', () => {
    const horizon = [
      {
        id: 'op-1',
        type: 'swapped' as const,
        amount: '10.0000000',
        asset: 'XLM',
        destAmount: '1.2000000',
        destAsset: 'USDC',
        counterparty: 'Stellar DEX',
        timestamp: 200,
        hash: 'tx-shared',
      },
    ]
    const eventRows = [
      {
        id: 'ev-1',
        type: 'sent' as const,
        amount: '10.0000000',
        asset: 'XLM',
        counterparty: OTHER_G,
        timestamp: 200,
        hash: 'tx-shared',
      },
    ]

    const merged = mergeHistory(horizon, eventRows)
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('op-1')
    expect(merged[0].type).toBe('swapped')
  })

  it('keeps two distinct payments in one transaction when Horizon has no row for that hash', () => {
    const payment1 = {
      id: 'ev-1',
      type: 'received' as const,
      amount: '10.0000000',
      asset: 'USDC',
      counterparty: SENDER_G,
      timestamp: 300,
      hash: 'tx-multi',
    }
    const payment2 = {
      id: 'ev-2',
      type: 'received' as const,
      amount: '5.0000000',
      asset: 'USDC',
      counterparty: OTHER_G,
      timestamp: 300,
      hash: 'tx-multi',
    }

    const merged = mergeHistory([], dedupeSecondarySources([payment1, payment2], []))
    expect(merged.map((r) => r.id)).toEqual(['ev-1', 'ev-2'])
  })

  it('removes duplicates when both RPC events and the indexer report the same transfer', () => {
    const eventRow = {
      id: 'ev-99',
      type: 'received' as const,
      amount: '25.0000000',
      asset: 'USDC',
      counterparty: SENDER_G,
      timestamp: 300,
      hash: 'tx-c-incoming',
    }
    const indexerRow = {
      id: 'w-42',
      type: 'received' as const,
      amount: '25.0000000',
      asset: 'USDC',
      counterparty: SENDER_G,
      timestamp: 300,
      hash: 'tx-c-incoming',
    }

    const merged = mergeHistory([], dedupeSecondarySources([eventRow], [indexerRow]))
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('ev-99')
  })
})

describe('loadContractSacActivity caching, paging, and failure handling', () => {
  beforeEach(() => {
    resetSacActivityCache()
  })

  it('stops paging when a page returns fewer than 100 events even if cursor is always present', async () => {
    let latestSeq = 50_000
    const initialEv = makeTransferEvent({
      id: 'ev-initial',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 10_000_000n,
      contractId: TESTNET_USDC_SAC,
      txHash: 'tx-initial',
      ledgerClosedAt: '2026-11-20T12:00:00Z',
    })
    const newEv = makeTransferEvent({
      id: 'ev-new',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 20_000_000n,
      contractId: TESTNET_XLM_SAC,
      txHash: 'tx-new',
      ledgerClosedAt: '2026-11-20T12:01:00Z',
    })

    const getLatestLedger = jest.fn(async () => ({ sequence: latestSeq }))
    const getEvents = jest.fn(async (req: SorobanRpc.Server.GetEventsRequest) => {
      if ('startLedger' in req && req.startLedger === 50_001) {
        return { events: [newEv], cursor: 'always-present-cursor' }
      }
      if ('endLedger' in req && req.endLedger === 50_000) {
        return { events: [initialEv], cursor: 'always-present-cursor' }
      }
      return { events: [], cursor: 'always-present-cursor' }
    })
    const server: SacRpcClient = { getLatestLedger, getEvents }

    // First call: 1 getLatestLedger + 3 getEvents (1 per chunk, NOT 4 per chunk)
    const first = await loadContractSacActivity([WALLET_C, SPENDING_G], 50, { server, network: 'testnet' })
    expect(first.failed).toBe(false)
    expect(first.records.map((r) => r.id)).toEqual(['ev-initial'])
    expect(getLatestLedger).toHaveBeenCalledTimes(1)
    expect(getEvents).toHaveBeenCalledTimes(3)

    // Second call (steady state): 1 getLatestLedger + 1 getEvents = 2 RPC calls
    getLatestLedger.mockClear()
    getEvents.mockClear()
    latestSeq = 50_005

    const second = await loadContractSacActivity([WALLET_C, SPENDING_G], 50, { server, network: 'testnet' })
    expect(second.failed).toBe(false)
    expect(second.records.map((r) => r.id)).toEqual(['ev-new', 'ev-initial'])
    expect(getLatestLedger).toHaveBeenCalledTimes(1)
    expect(getEvents).toHaveBeenCalledTimes(1)
  })

  it('does not record a back-scan as complete when a chunk fails, and retries on the next call', async () => {
    const server: SacRpcClient = {
      getLatestLedger: jest.fn(async () => ({ sequence: 70_000 })),
      getEvents: jest.fn(async () => {
        throw new Error('503 Service Unavailable')
      }),
    }

    const first = await loadContractSacActivity([WALLET_C], 50, { server, network: 'testnet' })
    expect(first.failed).toBe(true)
    expect(first.records).toEqual([])

    // Now the RPC recovers: because lastLedger was NOT advanced, it runs the
    // full back-scan (3 chunks) instead of skipping straight to incremental.
    const recoveredEv = makeTransferEvent({
      id: 'ev-recovered',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 30_000_000n,
      contractId: TESTNET_XLM_SAC,
      txHash: 'tx-recovered',
    })
    ;(server.getEvents as jest.Mock).mockReset()
    ;(server.getEvents as jest.Mock).mockImplementation(async (req: SorobanRpc.Server.GetEventsRequest) => {
      if ('endLedger' in req && req.endLedger === 70_000) {
        return { events: [recoveredEv] }
      }
      return { events: [] }
    })

    const second = await loadContractSacActivity([WALLET_C], 50, { server, network: 'testnet' })
    expect(second.failed).toBe(false)
    expect(second.records.map((r) => r.id)).toEqual(['ev-recovered'])
    expect(server.getEvents).toHaveBeenCalledTimes(3)
  })

  it('keeps cached rows and reports failed when a subsequent incremental scan is rate-limited', async () => {
    let latestSeq = 60_000
    const initialEv = makeTransferEvent({
      id: 'ev-cached',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 15_000_000n,
      contractId: TESTNET_XLM_SAC,
      txHash: 'tx-cached',
    })

    const server: SacRpcClient = {
      getLatestLedger: jest.fn(async () => ({ sequence: latestSeq })),
      getEvents: jest.fn(async (req: SorobanRpc.Server.GetEventsRequest) => {
        if ('endLedger' in req && req.endLedger === 60_000) {
          return { events: [initialEv] }
        }
        return { events: [] }
      }),
    }

    const first = await loadContractSacActivity([WALLET_C], 50, { server, network: 'testnet' })
    expect(first.failed).toBe(false)
    expect(first.records).toHaveLength(1)

    // Simulate rate-limit error on next refresh
    latestSeq = 60_010
    ;(server.getEvents as jest.Mock).mockRejectedValueOnce(new Error('429 Too Many Requests'))

    const second = await loadContractSacActivity([WALLET_C], 50, { server, network: 'testnet' })
    expect(second.failed).toBe(true)
    expect(second.records.map((r) => r.id)).toEqual(['ev-cached'])
  })

  it('marks a back-scan incomplete when a chunk fails at full width and only succeeds at half width', async () => {
    const partialEv = makeTransferEvent({
      id: 'ev-half',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 5_000_000n,
      contractId: TESTNET_XLM_SAC,
      txHash: 'tx-half',
    })

    const getEvents = jest.fn(async (req: SorobanRpc.Server.GetEventsRequest) => {
      if ('startLedger' in req && 'endLedger' in req && req.endLedger === 80_000) {
        const width = req.endLedger - req.startLedger + 1
        if (width >= 2_900) throw new Error('-32001 request exceeded processing limit')
        return { events: [partialEv] }
      }
      return { events: [] }
    })

    const server: SacRpcClient = {
      getLatestLedger: jest.fn(async () => ({ sequence: 80_000 })),
      getEvents,
    }

    const first = await loadContractSacActivity([WALLET_C], 50, { server, network: 'testnet' })
    expect(first.failed).toBe(true)
    expect(first.records.map((r) => r.id)).toEqual(['ev-half'])

    // Because lastLedger was NOT advanced, the next call retries the full back-scan
    getEvents.mockReset()
    getEvents.mockResolvedValue({ events: [] })
    const second = await loadContractSacActivity([WALLET_C], 50, { server, network: 'testnet' })
    expect(second.failed).toBe(false)
    expect(getEvents).toHaveBeenCalledTimes(3)
  })
})
