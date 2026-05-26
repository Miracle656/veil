'use client'

import { useState, useEffect, useCallback } from 'react'
import { StrKey } from '@stellar/stellar-sdk'
import { Contact, fetchContacts, addContact as addContactSupabase, removeContact as removeContactSupabase, updateContact as updateContactSupabase } from '@/lib/supabase'

export type { Contact }

export function useContacts() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [isLoaded, setIsLoaded] = useState(false)
  const [ownerContract, setOwnerContract] = useState<string | null>(null)

  // Initialize with wallet contract address from sessionStorage
  useEffect(() => {
    const addr = sessionStorage.getItem('invisible_wallet_address')
    setOwnerContract(addr)
  }, [])

  // Load contacts from Supabase when owner contract is available
  useEffect(() => {
    if (!ownerContract) {
      setIsLoaded(true)
      return
    }

    const loadContacts = async () => {
      try {
        const data = await fetchContacts(ownerContract)
        setContacts(data)
      } catch (err) {
        console.error('Failed to load contacts:', err)
      } finally {
        setIsLoaded(true)
      }
    }

    loadContacts()
  }, [ownerContract])

  const addContact = useCallback(async (name: string, address: string) => {
    if (!name.trim()) throw new Error('Name is required')
    if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) {
      throw new Error('Invalid Stellar address')
    }

    if (!ownerContract) {
      throw new Error('Wallet not initialized. Please refresh the page.')
    }

    try {
      const newContact = await addContactSupabase(ownerContract, name, address)
      if (newContact) {
        setContacts(prev => [newContact, ...prev])
      }
      return newContact
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add contact'
      throw new Error(msg)
    }
  }, [ownerContract])

  const removeContact = useCallback(async (id: string) => {
    try {
      await removeContactSupabase(id)
      setContacts(prev => prev.filter(c => c.id !== id))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to remove contact'
      throw new Error(msg)
    }
  }, [])

  const updateContact = useCallback(async (id: string, updates: Partial<Omit<Contact, 'id' | 'owner_contract' | 'created_at'>>) => {
    try {
      const updated = await updateContactSupabase(id, updates)
      if (updated) {
        setContacts(prev => prev.map(c => c.id === id ? updated : c))
      }
      return updated
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update contact'
      throw new Error(msg)
    }
  }, [])

  return {
    contacts,
    isLoaded,
    addContact,
    removeContact,
    updateContact,
  }
}
