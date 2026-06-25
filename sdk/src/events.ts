import { Horizon } from '@stellar/stellar-sdk'

export type ActivityEventType =
  | 'payment_received'
  | 'payment_sent'
  | 'account_created'
  | 'path_payment'

export interface ActivityEvent {
  id: string
  type: ActivityEventType
  amount: string
  asset: string
  counterparty: string
  timestamp: number
  hash: string
  memo?: string
  destAmount?: string
  destAsset?: string
}

export interface ActivityFeedConfig {
  accountId: string
  horizonUrl: string
  onEvent: (event: ActivityEvent) => void
  onError?: (err: Error) => void
}

export interface ActivityFeed {
  stop: () => void
}

export interface RawHorizonOp {
  id: string
  paging_token: string
  type: string
  from?: string
  to?: string
  funder?: string
  amount?: string
  starting_balance?: string
  asset_type?: string
  asset_code?: string
  source_amount?: string
  source_asset_type?: string
  source_asset_code?: string
  created_at: string
  transaction_hash: string
  transaction?: { memo?: string }
}

export function mapHorizonOpToEvent(op: RawHorizonOp, accountId: string): ActivityEvent | null {
  if (op.type === 'create_account') {
    return {
      id: op.paging_token,
      type: 'account_created',
      amount: op.starting_balance ?? '0',
      asset: 'XLM',
      counterparty: op.funder ?? 'Friendbot',
      timestamp: Math.floor(new Date(op.created_at).getTime() / 1000),
      hash: op.transaction_hash,
    }
  }

  if (op.type === 'path_payment_strict_send') {
    const srcAsset = op.source_asset_type === 'native' ? 'XLM' : (op.source_asset_code ?? 'XLM')
    const dstAsset = op.asset_type === 'native' ? 'XLM' : (op.asset_code ?? '')
    return {
      id: op.paging_token,
      type: 'path_payment',
      amount: op.source_amount ?? '0',
      asset: srcAsset,
      destAmount: op.amount ?? '0',
      destAsset: dstAsset,
      counterparty: 'Stellar DEX',
      timestamp: Math.floor(new Date(op.created_at).getTime() / 1000),
      hash: op.transaction_hash,
    }
  }

  if (op.type === 'payment') {
    const isSent = op.from === accountId
    const asset = op.asset_type === 'native' ? 'XLM' : (op.asset_code ?? '')
    return {
      id: op.paging_token,
      type: isSent ? 'payment_sent' : 'payment_received',
      amount: op.amount ?? '0',
      asset,
      counterparty: isSent ? (op.to ?? '') : (op.from ?? ''),
      timestamp: Math.floor(new Date(op.created_at).getTime() / 1000),
      hash: op.transaction_hash,
      memo: op.transaction?.memo,
    }
  }

  return null
}

export function createActivityFeed(config: ActivityFeedConfig): ActivityFeed {
  const { accountId, horizonUrl, onEvent, onError } = config

  let stopped = false
  let stopStream: (() => void) | null = null
  let lastCursor = 'now'
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 1_000
  const MAX_RECONNECT_DELAY = 30_000

  const server = new Horizon.Server(horizonUrl)

  function connect(): void {
    if (stopped) return

    stopStream = server
      .payments()
      .forAccount(accountId)
      .cursor(lastCursor)
      .stream({
        onmessage(op: any) {
          reconnectDelay = 1_000
          lastCursor = op.paging_token as string
          const event = mapHorizonOpToEvent(op as RawHorizonOp, accountId)
          if (event) onEvent(event)
        },
        onerror() {
          if (stopped) return
          stopStream?.()
          stopStream = null
          onError?.(new Error('Activity stream disconnected'))
          scheduleReconnect()
        },
      })
  }

  function scheduleReconnect(): void {
    if (stopped) return
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
      connect()
    }, reconnectDelay)
  }

  connect()

  return {
    stop() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      stopStream?.()
    },
  }
}
