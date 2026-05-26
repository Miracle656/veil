import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://vlnwwekmukgoretgdkcj.supabase.co'
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZsbnd3ZWttdWtnb3JldGdka2NqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyODg5NDEsImV4cCI6MjA5MDg2NDk0MX0.iJ5lr95PqzhgDpNZp4TqLdBXUcWl-6j0I7CctjkjXg0'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

/** Track a newly deployed wallet. Fire-and-forget — never blocks the UI. */
export async function trackWalletCreated(
  contractAddress: string,
  feePayerAddress: string,
) {
  try {
    await supabase.from('wallets').insert({
      contract_address: contractAddress,
      fee_payer_address: feePayerAddress,
    })
  } catch {
    // Silent — analytics must never break the wallet flow
  }
}

/** Contact management for Supabase-backed address book */

export interface Contact {
  id: string
  owner_contract: string
  name: string
  address: string
  created_at: string
}

export async function fetchContacts(ownerContract: string): Promise<Contact[]> {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, owner_contract, name, address, created_at')
      .eq('owner_contract', ownerContract)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Failed to fetch contacts:', error)
      return []
    }

    return data || []
  } catch (err) {
    console.error('Unexpected error fetching contacts:', err)
    return []
  }
}

export async function addContact(
  ownerContract: string,
  name: string,
  address: string,
): Promise<Contact | null> {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .insert({
        owner_contract: ownerContract,
        name: name.trim(),
        address: address.trim(),
      })
      .select('id, owner_contract, name, address, created_at')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return data
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to add contact'
    throw new Error(msg)
  }
}

export async function removeContact(id: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', id)

    if (error) {
      throw new Error(error.message)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to remove contact'
    throw new Error(msg)
  }
}

export async function updateContact(
  id: string,
  updates: Partial<Omit<Contact, 'id' | 'owner_contract' | 'created_at'>>,
): Promise<Contact | null> {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .update(updates)
      .eq('id', id)
      .select('id, owner_contract, name, address, created_at')
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return data
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to update contact'
    throw new Error(msg)
  }
}
