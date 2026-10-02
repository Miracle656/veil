import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StrKey } from '@stellar/stellar-sdk';

export interface Contact {
  id: string;
  name: string;
  address: string;
}

const STORAGE_KEY = 'veil_contacts';

export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address);
}

export function useContacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (cancelled || !saved) return;
        try {
          setContacts(JSON.parse(saved));
        } catch (err) {
          console.error('Failed to parse contacts from storage', err);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(contacts)).catch((err) => {
      console.error('Failed to persist contacts to storage', err);
    });
  }, [contacts, isLoaded]);

  const addContact = useCallback((name: string, address: string) => {
    const trimmedName = name.trim();
    const trimmedAddress = address.trim();

    if (!trimmedName) throw new Error('Name is required');
    if (!isValidStellarAddress(trimmedAddress)) throw new Error('Invalid Stellar address');

    const newContact: Contact = {
      id: Date.now().toString(),
      name: trimmedName,
      address: trimmedAddress,
    };

    setContacts((prev) => [...prev, newContact]);
    return newContact;
  }, []);

  const removeContact = useCallback((id: string) => {
    setContacts((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const updateContact = useCallback((id: string, updates: Partial<Omit<Contact, 'id'>>) => {
    if (updates.name !== undefined && !updates.name.trim()) {
      throw new Error('Name is required');
    }
    if (updates.address !== undefined && !isValidStellarAddress(updates.address.trim())) {
      throw new Error('Invalid Stellar address');
    }

    setContacts((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              ...updates,
              name: updates.name !== undefined ? updates.name.trim() : c.name,
              address: updates.address !== undefined ? updates.address.trim() : c.address,
            }
          : c
      )
    );
  }, []);

  return {
    contacts,
    isLoaded,
    addContact,
    removeContact,
    updateContact,
  };
}
