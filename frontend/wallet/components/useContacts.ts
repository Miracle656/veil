'use client'

import { useState, useEffect, useCallback } from 'react'
import { StrKey } from '@stellar/stellar-sdk'
import { supabase } from '@/lib/supabase'

export interface Contact {
  id: string
  name: string
  address: string
}

/** Fetch the current wallet's C... contract address from session storage. */
function getOwnerContract(): string | null {
  if (typeof window === 'undefined') return null
  return sessionStorage.getItem('invisible_wallet_address')
}

export function useContacts() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [isLoaded, setIsLoaded] = useState(false)

  const ownerContract = getOwnerContract()

  // ── Load contacts from Supabase ──────────────────────────────────────────
  const fetchContacts = useCallback(async () => {
    if (!ownerContract) {
      setIsLoaded(true)
      return
    }

    const { data, error } = await supabase
      .from('contacts')
      .select('id, name, address')
      .eq('owner_contract', ownerContract)
      .order('name', { ascending: true })

    if (error) {
      console.error('Failed to load contacts', error)
    } else {
      setContacts(data ?? [])
    }
    setIsLoaded(true)
  }, [ownerContract])

  useEffect(() => {
    fetchContacts()
  }, [fetchContacts])

  // ── Add ────────────────────────────────────────────────────────────────────
  const addContact = useCallback(async (name: string, address: string) => {
    if (!name.trim()) throw new Error('Name is required')
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) {
      throw new Error('Invalid Stellar address')
    }
    if (!ownerContract) throw new Error('No wallet connected')

    const trimmedName = name.trim()
    const trimmedAddr = address.trim()

    // Check for duplicate address in local state first (fast feedback)
    if (contacts.some(c => c.address === trimmedAddr)) {
      throw new Error('This address is already in your contacts')
    }

    const { data, error } = await supabase
      .from('contacts')
      .insert({
        owner_contract: ownerContract,
        name: trimmedName,
        address: trimmedAddr,
      })
      .select('id, name, address')
      .single()

    if (error) {
      if (error.code === '23505') throw new Error('This address is already in your contacts')
      throw new Error(error.message)
    }

    setContacts(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)))
    return data
  }, [ownerContract, contacts])

  // ── Remove ─────────────────────────────────────────────────────────────────
  const removeContact = useCallback(async (id: string) => {
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', id)
      .eq('owner_contract', ownerContract ?? '')

    if (error) throw new Error(error.message)
    setContacts(prev => prev.filter(c => c.id !== id))
  }, [ownerContract])

  // ── Update ─────────────────────────────────────────────────────────────────
  const updateContact = useCallback(async (id: string, updates: Partial<Omit<Contact, 'id'>>) => {
    const { error } = await supabase
      .from('contacts')
      .update(updates)
      .eq('id', id)
      .eq('owner_contract', ownerContract ?? '')

    if (error) throw new Error(error.message)
    setContacts(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c))
  }, [ownerContract])

  return {
    contacts,
    isLoaded,
    addContact,
    removeContact,
    updateContact,
  }
}
