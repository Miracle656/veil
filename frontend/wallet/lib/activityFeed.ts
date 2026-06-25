'use client'

import { useState, useEffect } from 'react'
import { createActivityFeed, type ActivityEvent, type ActivityFeed } from '@veil/events'
import { getNetwork } from './network'
import type { TxRecord } from '@/components/TxDetailSheet'

export type { ActivityEvent }

type ActivityListener = (records: TxRecord[]) => void

let _records: TxRecord[] = []
let _feed: ActivityFeed | null = null
let _currentAccountId: string | null = null
const _listeners = new Set<ActivityListener>()

function notify(): void {
  for (const listener of _listeners) listener([..._records])
}

function toTxRecord(event: ActivityEvent): TxRecord {
  return {
    id: event.id,
    type:
      event.type === 'payment_sent'
        ? 'sent'
        : event.type === 'path_payment'
        ? 'swapped'
        : 'received',
    amount: event.amount,
    asset: event.asset,
    counterparty: event.counterparty,
    timestamp: event.timestamp,
    hash: event.hash,
    memo: event.memo,
    destAmount: event.destAmount,
    destAsset: event.destAsset,
  }
}

export function initActivityFeed(accountId: string): void {
  if (_feed && _currentAccountId === accountId) return

  _feed?.stop()
  _currentAccountId = accountId

  const { horizonUrl } = getNetwork()

  _feed = createActivityFeed({
    accountId,
    horizonUrl,
    onEvent(event) {
      const record = toTxRecord(event)
      if (_records.some(r => r.hash === record.hash)) return
      _records = [record, ..._records].slice(0, 50)
      notify()
    },
  })
}

export function stopActivityFeed(): void {
  _feed?.stop()
  _feed = null
  _currentAccountId = null
}

export function hydrateActivityFeed(records: TxRecord[]): void {
  _records = records
  notify()
}

export function subscribeActivityFeed(listener: ActivityListener): () => void {
  _listeners.add(listener)
  listener([..._records])
  return () => _listeners.delete(listener)
}

export function useActivityFeed(): TxRecord[] {
  const [records, setRecords] = useState<TxRecord[]>(() => [..._records])

  useEffect(() => subscribeActivityFeed(setRecords), [])

  return records
}

