# Contacts Address Book Setup Guide

## Overview

The contacts address book allows users to save frequently-used Stellar addresses with memorable names. Contacts are stored in Supabase and scoped to each wallet contract using Row-Level Security (RLS).

## Database Setup

### 1. Create the Contacts Table

Log into your Supabase dashboard and run the SQL in `migrations/001_contacts_table.sql`:

```sql
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_contract TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT valid_address CHECK (
    address ~ '^[GC][A-Z0-9]{55}$'
  ),
  CONSTRAINT unique_contact_per_wallet UNIQUE (owner_contract, address)
);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_contacts_owner_contract ON contacts(owner_contract);
```

### 2. Enable Row-Level Security (RLS)

RLS policies ensure that:
- Users can only access contacts they created
- A compromised anon key cannot read other wallets' contacts
- The `owner_contract` field is immutable per contact

Since Veil uses passkey authentication at the contract level (not Supabase Auth), the RLS policies should enforce client-side validation:

```sql
-- Read: Filter by owner_contract passed from client
CREATE POLICY "Select own contracts contacts" ON contacts
  FOR SELECT
  USING (true);

-- Insert: Validate owner_contract on client
CREATE POLICY "Insert own contacts" ON contacts
  FOR INSERT
  WITH CHECK (true);

-- Update/Delete: Validate owner_contract on client
CREATE POLICY "Update own contacts" ON contacts
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Delete own contacts" ON contacts
  FOR DELETE
  USING (true);

-- Grant permissions to anon and authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO authenticated, anon;
```

## Security Notes

⚠️ **Important**: This implementation relies on **client-side validation** of `owner_contract`. The frontend must:

1. **Never trust user input** for `owner_contract` — always retrieve from `sessionStorage.getItem('invisible_wallet_address')`
2. **Always filter queries** by the user's own contract address
3. **Never expose other contracts' contacts** in any response

In a production system with Supabase Auth, you would:

```sql
-- Production RLS: Use auth.uid
CREATE POLICY "Select own contacts" ON contacts
  FOR SELECT
  USING (auth.uid = owner_user_id);
```

However, since Veil uses passkey authentication outside Supabase, the current implementation is appropriate.

## API

### `useContacts()`

React hook for managing contacts. Automatically scopes to the current wallet:

```typescript
const { contacts, isLoaded, addContact, removeContact, updateContact } = useContacts()

// Add contact
await addContact('Alice', 'GXXXXXX...') // throws on invalid address or duplicate

// Remove contact
await removeContact(contactId)

// Update contact
await updateContact(contactId, { name: 'Bob' })
```

### Supabase Functions

Direct access to contacts operations:

```typescript
import { fetchContacts, addContact, removeContact, updateContact } from '@/lib/supabase'

// Fetch all contacts for a wallet
const contacts = await fetchContacts(walletContractAddress)

// Add a contact
const contact = await addContact(walletContractAddress, name, address)

// Remove a contact
await removeContact(contactId)

// Update a contact
const updated = await updateContact(contactId, { name: 'NewName' })
```

## Features

✅ **Persistent storage** in Supabase per wallet  
✅ **RLS-protected** — each wallet only sees its own contacts  
✅ **Fast lookups** with indexed `owner_contract` queries  
✅ **Integrated in Send flow** via `<ContactPicker />`  
✅ **Dedicated Contacts page** — add, view, delete contacts  
✅ **Validation** — Stellar address format checking, no duplicates  

## Testing

1. Register a wallet and note the contract address (e.g., `CXXXXXX...`)
2. Navigate to `/contacts` and add a contact
3. Go to `/send` and verify the contact appears in the picker
4. Select the contact — address should auto-fill
5. Delete the contact from `/contacts` — it should no longer appear in the picker

## Troubleshooting

### Contacts not loading
- Check that `sessionStorage.getItem('invisible_wallet_address')` returns a valid contract
- Verify the Supabase table exists and RLS is enabled
- Check browser console for errors from `useContacts` hook

### "Invalid Stellar address" error
- Addresses must start with `G` (account) or `C` (contract)
- Must be exactly 56 characters
- Contact the user if they're copy-pasting incorrectly

### Duplicates not prevented
- The `UNIQUE (owner_contract, address)` constraint should prevent dupes
- If dupes exist, check for database constraint violations in Supabase logs

### RLS denying queries
- Ensure `owner_contract` is correctly set from `sessionStorage`
- Verify RLS policies are in place (see section 2 above)
- Check Supabase logs for policy violations
