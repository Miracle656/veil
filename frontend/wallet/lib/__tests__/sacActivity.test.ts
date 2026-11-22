/** @jest-environment node */
import { Address, Asset, Keypair, StrKey, nativeToScVal, xdr, type rpc as SorobanRpc } from '@stellar/stellar-sdk'
import { KNOWN_SAC_CONTRACT_IDS } from '../assets'
import { NETWORKS } from '../network'
import { mergeHistory } from '../walletHistory'
import {
  assetFromContractId,
  assetFromTopic,
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

function makeTransferEvent(opts: {
  id: string
  from: string
  to: string
  stroops: bigint
  assetTopic?: string | null
  txHash: string
  ledgerClosedAt?: string
  contractId?: string
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
    contractId: opts.contractId ?? UNKNOWN_CONTRACT,
    id: opts.id,
    pagingToken: opts.id,
    topic,
    value: nativeToScVal(opts.stroops, { type: 'i128' }),
    inSuccessfulContractCall: true,
    txHash: opts.txHash,
  } as unknown as SorobanRpc.Api.EventResponse
}

describe('SAC transfer event mapping', () => {
  it('maps an incoming transfer sent straight to the wallet C address with the right token and amount', () => {
    const ev = makeTransferEvent({
      id: 'ev-1',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 125_000_000n, // 12.5 USDC
      assetTopic: `USDC:${ISSUER_G}`,
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

  it('maps an outgoing native XLM transfer from the wallet C address', () => {
    const ev = makeTransferEvent({
      id: 'ev-2',
      from: WALLET_C,
      to: OTHER_G,
      stroops: 50_000_000n,
      assetTopic: 'native',
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
      assetTopic: 'native',
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
      assetTopic: 'native',
      txHash: 'tx-other',
    })

    expect(mapSacTransferEvents([ev], [WALLET_C, SPENDING_G], 'testnet')).toEqual([])
  })
})

describe('token lookup', () => {
  it('reads XLM and issued asset codes from the fourth SAC topic', () => {
    expect(assetFromTopic(nativeToScVal('native', { type: 'string' }))).toBe('XLM')
    expect(assetFromTopic(nativeToScVal(`USDC:${ISSUER_G}`, { type: 'string' }))).toBe('USDC')
    expect(assetFromTopic(undefined)).toBe('XLM')
  })

  it('resolves verified contract IDs and never defaults unknown contracts to XLM', () => {
    expect(assetFromContractId(Asset.native().contractId(NETWORKS.testnet.networkPassphrase), 'testnet')).toBe('XLM')
    expect(assetFromContractId(Asset.native().contractId(NETWORKS.mainnet.networkPassphrase), 'mainnet')).toBe('XLM')
    expect(assetFromContractId(KNOWN_SAC_CONTRACT_IDS.testnet.USDC, 'testnet')).toBe('USDC')
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

  it('never shows a transaction twice when both RPC events and the indexer report it', () => {
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

    const merged = mergeHistory([], [eventRow, indexerRow])
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe('ev-99')
  })
})

describe('loadContractSacActivity caching and steady-state polling', () => {
  beforeEach(() => {
    resetSacActivityCache()
  })

  it('runs one back-scan, then makes at most 2 RPC requests on steady-state refreshes', async () => {
    let latestSeq = 50_000
    const initialEv = makeTransferEvent({
      id: 'ev-initial',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 10_000_000n,
      assetTopic: `USDC:${ISSUER_G}`,
      txHash: 'tx-initial',
      ledgerClosedAt: '2026-11-20T12:00:00Z',
    })
    const newEv = makeTransferEvent({
      id: 'ev-new',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 20_000_000n,
      assetTopic: 'native',
      txHash: 'tx-new',
      ledgerClosedAt: '2026-11-20T12:01:00Z',
    })

    const getLatestLedger = jest.fn(async () => ({ sequence: latestSeq }))
    const getEvents = jest.fn(async (req: SorobanRpc.Server.GetEventsRequest) => {
      if ('startLedger' in req && req.startLedger === 50_001) {
        return { events: [newEv] }
      }
      if ('endLedger' in req && req.endLedger === 50_000) {
        return { events: [initialEv] }
      }
      return { events: [] }
    })
    const server: SacRpcClient = { getLatestLedger, getEvents }

    // First call: full back-scan (3 chunks)
    const first = await loadContractSacActivity([WALLET_C, SPENDING_G], 50, { server, network: 'testnet' })
    expect(first.map((r) => r.id)).toEqual(['ev-initial'])
    expect(getLatestLedger).toHaveBeenCalledTimes(1)
    expect(getEvents).toHaveBeenCalledTimes(3)

    // Second call (steady state): 1 getLatestLedger + 1 getEvents = 2 RPC calls
    getLatestLedger.mockClear()
    getEvents.mockClear()
    latestSeq = 50_005

    const second = await loadContractSacActivity([WALLET_C, SPENDING_G], 50, { server, network: 'testnet' })
    expect(second.map((r) => r.id)).toEqual(['ev-new', 'ev-initial'])
    expect(getLatestLedger).toHaveBeenCalledTimes(1)
    expect(getEvents).toHaveBeenCalledTimes(1)
  })

  it('keeps cached rows when a subsequent scan fails or is rate-limited', async () => {
    let latestSeq = 60_000
    const initialEv = makeTransferEvent({
      id: 'ev-cached',
      from: SENDER_G,
      to: WALLET_C,
      stroops: 15_000_000n,
      assetTopic: 'native',
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
    expect(first).toHaveLength(1)

    // Simulate rate-limit error on next refresh
    latestSeq = 60_010
    ;(server.getEvents as jest.Mock).mockRejectedValueOnce(new Error('429 Too Many Requests'))

    const second = await loadContractSacActivity([WALLET_C], 50, { server, network: 'testnet' })
    expect(second.map((r) => r.id)).toEqual(['ev-cached'])
  })
})
