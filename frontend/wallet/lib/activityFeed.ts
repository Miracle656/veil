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
      // By row id, not by transaction hash: one transaction can hold a
      // payment and its fee, and both belong in the list.
      if (_records.some(r => r.id === record.id)) return
      _records = [record, ..._records].slice(0, 200)
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

export function appendActivityFeed(newRecords: TxRecord[]): void {
  // A row is a repeat when its id is already here. A row from the indexer
  // (id `w-…`) is also a repeat when Horizon already gave us that transaction.
  const deduped = newRecords.filter(r => !_records.some(existing =>
    existing.id === r.id || (r.id.startsWith('w-') && !!r.hash && existing.hash === r.hash)))
  if (deduped.length === 0) return
  _records = [..._records, ...deduped].sort((a, b) => b.timestamp - a.timestamp)
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

