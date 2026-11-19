/**
 * Deposit addresses of cash-out orders made in this browser.
 *
 * An offramp payment on Stellar looks like any other USDC transfer to a
 * stranger's G-address — the naira payout happens entirely off-chain, so
 * nothing in ledger history records that a particular send was a cash-out.
 *
 * The phone app (frontend/mobile/lib/offramp.ts) remembers the deposit
 * addresses it sent to so Activity can label them "Cashed out" rather than
 * "Sent". This module provides the web wallet's counterpart:
 *
 * - Scoped per network and per wallet (a testnet cash-out never labels a
 *   mainnet send, and one wallet's memory never bleeds into another).
 * - Capped at 50 addresses (MRU order), matching the phone client.
 * - Stores ONLY deposit addresses. Never stores bank details, names,
 *   amounts or orders.
 * - Cleared when the wallet is reset.
 */

import { getNetworkName, namespaceKey, type VeilNetworkName } from './network'
import type { TxRecord } from '@/components/TxDetailSheet'

/** Sensible cap matching mobile (frontend/mobile/lib/offramp.ts). */
export const MAX_REMEMBERED_ADDRESSES = 50

export function depositAddressesKey(network: string, walletAddress: string): string {
  return `veil_cashout_deposit_addresses:${network}:${walletAddress}`
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
    if (typeof window !== 'undefined') return window.localStorage
    return null
  } catch {
    return null
  }
}

function getSessionStorage(): Storage | null {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage
    if (typeof window !== 'undefined') return window.sessionStorage
    return null
  } catch {
    return null
  }
}

function getActiveWalletAddress(networkName?: string): string | null {
  const activeNetwork = (networkName as VeilNetworkName) ?? getNetworkName()
  try {
    const session = getSessionStorage()
    if (session) {
      const addr = session.getItem(namespaceKey('invisible_wallet_address', activeNetwork))
      if (addr) return addr
    }
    const local = getLocalStorage()
    if (local) {
      const addr = local.getItem(namespaceKey('invisible_wallet_address', activeNetwork))
      if (addr) return addr
    }
    return null
  } catch {
    return null
  }
}

/**
 * Remembers a cash-out deposit address for this wallet on this network.
 * Only the address is stored — never bank details, names, or amounts.
 */
export function rememberDepositAddress(
  address: string,
  walletAddress?: string,
  network?: string,
): void {
  const store = getLocalStorage()
  if (!store || !address || typeof address !== 'string' || address.trim() === '') return
  const cleanAddress = address.trim()
  const activeNetwork = network ?? getNetworkName()
  const addr = walletAddress || getActiveWalletAddress(activeNetwork)
  if (!addr) return

  const key = depositAddressesKey(activeNetwork, addr)
  try {
    const known = knownDepositAddresses(addr, activeNetwork)
    const filtered = known.filter((a) => a !== cleanAddress)
    const next = [cleanAddress, ...filtered].slice(0, MAX_REMEMBERED_ADDRESSES)
    store.setItem(key, JSON.stringify(next))
  } catch {
    // Labelling is a nicety; never let storage failure fail a cash-out flow.
  }
}

/**
 * Retrieves the deposit addresses remembered for this wallet and network,
 * newest first.
 */
export function knownDepositAddresses(
  walletAddress?: string,
  network?: string,
): string[] {
  const store = getLocalStorage()
  if (!store) return []
  const activeNetwork = network ?? getNetworkName()
  const addr = walletAddress || getActiveWalletAddress(activeNetwork)
  if (!addr) return []

  try {
    const raw = store.getItem(depositAddressesKey(activeNetwork, addr))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((a): a is string => typeof a === 'string' && a.length > 0)
      : []
  } catch {
    return []
  }
}

/**
 * Whether the given address is a known cash-out deposit address for this wallet.
 */
export function isDepositAddress(
  address: string,
  walletAddress?: string,
  network?: string,
): boolean {
  if (!address || typeof address !== 'string') return false
  const cleanAddress = address.trim()
  const known = knownDepositAddresses(walletAddress, network)
  return known.includes(cleanAddress)
}

/**
 * Removes remembered deposit addresses for a wallet on a network.
 * Called when a wallet is reset.
 */
export function clearRememberedDepositAddresses(
  walletAddress?: string,
  network?: string,
): void {
  const store = getLocalStorage()
  if (!store) return
  const activeNetwork = network ?? getNetworkName()
  const addr = walletAddress || getActiveWalletAddress(activeNetwork)

  try {
    if (addr) {
      store.removeItem(depositAddressesKey(activeNetwork, addr))
    } else {
      // If no specific wallet is known, clean up any deposit address keys for this network
      const prefix = `veil_cashout_deposit_addresses:${activeNetwork}:`
      const toRemove: string[] = []
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)
        if (key && key.startsWith(prefix)) {
          toRemove.push(key)
        }
      }
      for (const k of toRemove) {
        store.removeItem(k)
      }
    }
  } catch {
    // Ignore storage errors on cleanup
  }
}

export type TxDisplayLabel = 'Cashed out' | 'Sent' | 'Received' | 'Swapped' | 'Swap'

/**
 * Returns the human-readable label for a transaction row or detail sheet.
 * Sent rows whose counterparty matches a remembered cash-out deposit address
 * read "Cashed out" instead of "Sent".
 */
export function txLabel(
  tx: Pick<TxRecord, 'type' | 'counterparty'>,
  knownAddresses?: Iterable<string> | ((address: string) => boolean),
  options?: { swapLabel?: 'Swap' | 'Swapped' },
): TxDisplayLabel {
  if (tx.type === 'swapped') {
    return options?.swapLabel ?? 'Swapped'
  }
  if (tx.type === 'received') {
    return 'Received'
  }

  // tx.type === 'sent'
  let isCashedOut = false
  if (typeof knownAddresses === 'function') {
    isCashedOut = knownAddresses(tx.counterparty)
  } else if (knownAddresses) {
    if (knownAddresses instanceof Set) {
      isCashedOut = knownAddresses.has(tx.counterparty)
    } else if (Array.isArray(knownAddresses)) {
      isCashedOut = knownAddresses.includes(tx.counterparty)
    } else {
      isCashedOut = Array.from(knownAddresses).includes(tx.counterparty)
    }
  } else {
    isCashedOut = isDepositAddress(tx.counterparty)
  }

  return isCashedOut ? 'Cashed out' : 'Sent'
}
