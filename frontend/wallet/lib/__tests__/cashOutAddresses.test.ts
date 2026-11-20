import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  depositAddressesKey,
  rememberDepositAddress,
  knownDepositAddresses,
  isDepositAddress,
  clearRememberedDepositAddresses,
  txLabel,
  MAX_REMEMBERED_ADDRESSES,
} from '../cashOutAddresses'
import { clearActiveNetworkWallet } from '../walletStorage'
import type { TxRecord } from '@/components/TxDetailSheet'

describe('cashOutAddresses', () => {
  const WALLET_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const WALLET_B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
  const DEP_1 = 'GDEP1111111111111111111111111111111111111111111111111111'
  const DEP_2 = 'GDEP2222222222222222222222222222222222222222222222222222'
  const DEP_3 = 'GDEP3333333333333333333333333333333333333333333333333333'
  const STRANGER = 'GSTRANGER11111111111111111111111111111111111111111111111'

  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    sessionStorage.setItem('invisible_wallet_address', WALLET_A)
  })

  afterEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  describe('depositAddressesKey', () => {
    it('scopes by network and wallet address', () => {
      const keyTestnetA = depositAddressesKey('testnet', WALLET_A)
      const keyMainnetA = depositAddressesKey('mainnet', WALLET_A)
      const keyTestnetB = depositAddressesKey('testnet', WALLET_B)

      expect(keyTestnetA).toBe(`veil_cashout_deposit_addresses:testnet:${WALLET_A}`)
      expect(keyTestnetA).not.toBe(keyMainnetA)
      expect(keyTestnetA).not.toBe(keyTestnetB)
    })
  })

  describe('rememberDepositAddress & knownDepositAddresses', () => {
    it('remembers a deposit address and retrieves it newest-first', () => {
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')
      rememberDepositAddress(DEP_2, WALLET_A, 'testnet')

      const known = knownDepositAddresses(WALLET_A, 'testnet')
      expect(known).toEqual([DEP_2, DEP_1])
    })

    it('deduplicates addresses and moves re-seen address to front', () => {
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')
      rememberDepositAddress(DEP_2, WALLET_A, 'testnet')
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')

      const known = knownDepositAddresses(WALLET_A, 'testnet')
      expect(known).toEqual([DEP_1, DEP_2])
      expect(known).toHaveLength(2)
    })

    it('caps remembered addresses at MAX_REMEMBERED_ADDRESSES (50)', () => {
      for (let i = 0; i < 55; i++) {
        rememberDepositAddress(`GADDR_${i.toString().padStart(3, '0')}`, WALLET_A, 'testnet')
      }

      const known = knownDepositAddresses(WALLET_A, 'testnet')
      expect(known).toHaveLength(MAX_REMEMBERED_ADDRESSES)
      expect(known[0]).toBe('GADDR_054')
      expect(known[49]).toBe('GADDR_005')
      expect(known).not.toContain('GADDR_004')
      expect(known).not.toContain('GADDR_000')
    })

    it('stores ONLY deposit addresses — no personal data, bank details, or amounts', () => {
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')
      const raw = localStorage.getItem(depositAddressesKey('testnet', WALLET_A))
      expect(raw).toBeTruthy()

      const parsed: unknown = JSON.parse(raw!)
      expect(Array.isArray(parsed)).toBe(true)
      const arr = parsed as unknown[]
      for (const item of arr) {
        expect(typeof item).toBe('string')
        // Address starts with G and has no object fields
        expect(item).toBe(DEP_1)
      }
    })

    it('ignores empty or invalid address strings', () => {
      rememberDepositAddress('', WALLET_A, 'testnet')
      rememberDepositAddress('   ', WALLET_A, 'testnet')
      // @ts-expect-error testing invalid type
      rememberDepositAddress(null, WALLET_A, 'testnet')
      // @ts-expect-error testing invalid type
      rememberDepositAddress(undefined, WALLET_A, 'testnet')

      expect(knownDepositAddresses(WALLET_A, 'testnet')).toEqual([])
    })

    it('falls back to active wallet address in storage if omitted', () => {
      rememberDepositAddress(DEP_1)
      expect(knownDepositAddresses()).toContain(DEP_1)
      expect(knownDepositAddresses(WALLET_A, 'testnet')).toContain(DEP_1)
    })

    it('returns empty array when storage is empty or malformed', () => {
      expect(knownDepositAddresses(WALLET_B, 'testnet')).toEqual([])

      localStorage.setItem(depositAddressesKey('testnet', WALLET_A), '{ invalid: json')
      expect(knownDepositAddresses(WALLET_A, 'testnet')).toEqual([])

      localStorage.setItem(depositAddressesKey('testnet', WALLET_A), JSON.stringify({ not: 'an array' }))
      expect(knownDepositAddresses(WALLET_A, 'testnet')).toEqual([])
    })
  })

  describe('network and wallet separation', () => {
    it('keeps testnet and mainnet remembered addresses separate', () => {
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')
      rememberDepositAddress(DEP_2, WALLET_A, 'mainnet')

      expect(knownDepositAddresses(WALLET_A, 'testnet')).toEqual([DEP_1])
      expect(knownDepositAddresses(WALLET_A, 'mainnet')).toEqual([DEP_2])
      expect(isDepositAddress(DEP_1, WALLET_A, 'mainnet')).toBe(false)
      expect(isDepositAddress(DEP_2, WALLET_A, 'testnet')).toBe(false)
    })

    it('keeps different wallets on the same network separate', () => {
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')
      rememberDepositAddress(DEP_2, WALLET_B, 'testnet')

      expect(knownDepositAddresses(WALLET_A, 'testnet')).toEqual([DEP_1])
      expect(knownDepositAddresses(WALLET_B, 'testnet')).toEqual([DEP_2])
      expect(isDepositAddress(DEP_1, WALLET_B, 'testnet')).toBe(false)
      expect(isDepositAddress(DEP_2, WALLET_A, 'testnet')).toBe(false)
    })
  })

  describe('isDepositAddress', () => {
    it('returns true only for known deposit addresses of that wallet and network', () => {
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')

      expect(isDepositAddress(DEP_1, WALLET_A, 'testnet')).toBe(true)
      expect(isDepositAddress(DEP_2, WALLET_A, 'testnet')).toBe(false)
      expect(isDepositAddress(STRANGER, WALLET_A, 'testnet')).toBe(false)
      expect(isDepositAddress('', WALLET_A, 'testnet')).toBe(false)
    })
  })

  describe('clearRememberedDepositAddresses & wallet reset', () => {
    it('clears remembered addresses for the active wallet and network', () => {
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')
      rememberDepositAddress(DEP_2, WALLET_B, 'testnet')
      rememberDepositAddress(DEP_3, WALLET_A, 'mainnet')

      clearRememberedDepositAddresses(WALLET_A, 'testnet')

      expect(knownDepositAddresses(WALLET_A, 'testnet')).toEqual([])
      // Wallet B on testnet is untouched
      expect(knownDepositAddresses(WALLET_B, 'testnet')).toEqual([DEP_2])
      // Wallet A on mainnet is untouched
      expect(knownDepositAddresses(WALLET_A, 'mainnet')).toEqual([DEP_3])
    })

    it('is cleared when clearActiveNetworkWallet() is called on reset', () => {
      sessionStorage.setItem('invisible_wallet_address', WALLET_A)
      localStorage.setItem('invisible_wallet_address', WALLET_A)
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')
      rememberDepositAddress(DEP_2, WALLET_A, 'mainnet')

      expect(knownDepositAddresses(WALLET_A, 'testnet')).toEqual([DEP_1])

      // Reset active network (testnet) wallet
      clearActiveNetworkWallet()

      expect(knownDepositAddresses(WALLET_A, 'testnet')).toEqual([])
      // Coexisting mainnet wallet state survives
      expect(knownDepositAddresses(WALLET_A, 'mainnet')).toEqual([DEP_2])
    })
  })

  describe('txLabel (label choice)', () => {
    const baseTx = (type: TxRecord['type'], counterparty: string): Pick<TxRecord, 'type' | 'counterparty'> => ({
      type,
      counterparty,
    })

    it('labels a sent row as "Cashed out" when counterparty is a remembered deposit address', () => {
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')

      const label = txLabel(baseTx('sent', DEP_1))
      expect(label).toBe('Cashed out')
    })

    it('labels a sent row as "Sent" when counterparty is not a remembered deposit address', () => {
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')

      const label = txLabel(baseTx('sent', STRANGER))
      expect(label).toBe('Sent')
    })

    it('labels a received row as "Received", even if counterparty is in deposit addresses', () => {
      rememberDepositAddress(DEP_1, WALLET_A, 'testnet')

      const labelWithDeposit = txLabel(baseTx('received', DEP_1))
      expect(labelWithDeposit).toBe('Received')

      const labelWithStranger = txLabel(baseTx('received', STRANGER))
      expect(labelWithStranger).toBe('Received')
    })

    it('labels a swapped row as "Swapped" (or "Swap" when configured)', () => {
      expect(txLabel(baseTx('swapped', 'Stellar DEX'))).toBe('Swapped')
      expect(txLabel(baseTx('swapped', 'Stellar DEX'), undefined, { swapLabel: 'Swap' })).toBe('Swap')
    })

    it('supports explicitly passed knownAddresses array or Set', () => {
      const knownList = [DEP_1, DEP_2]
      const knownSet = new Set([DEP_1, DEP_2])

      expect(txLabel(baseTx('sent', DEP_1), knownList)).toBe('Cashed out')
      expect(txLabel(baseTx('sent', DEP_1), knownSet)).toBe('Cashed out')
      expect(txLabel(baseTx('sent', STRANGER), knownList)).toBe('Sent')
      expect(txLabel(baseTx('sent', STRANGER), knownSet)).toBe('Sent')
    })

    it('supports explicitly passed predicate function', () => {
      const predicate = (addr: string) => addr === DEP_1

      expect(txLabel(baseTx('sent', DEP_1), predicate)).toBe('Cashed out')
      expect(txLabel(baseTx('sent', DEP_2), predicate)).toBe('Sent')
    })
  })
})
