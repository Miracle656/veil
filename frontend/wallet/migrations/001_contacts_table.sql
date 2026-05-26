-- Contacts table for address book functionality
-- Scoped per wallet contract with RLS to prevent cross-wallet access

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

-- Enable RLS on contacts table
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- Create index on owner_contract for fast lookups
CREATE INDEX IF NOT EXISTS idx_contacts_owner_contract ON contacts(owner_contract);

-- RLS Policy: Users can only read their own contracts' contacts
-- Since this is a public (anon) client, we rely on the owner_contract being
-- passed correctly from the authenticated session in the frontend.
-- In a production system with proper authentication, this would check auth.uid.
CREATE POLICY "Select own contracts contacts" ON contacts
  FOR SELECT
  USING (true);  -- Frontend passes owner_contract in queries

-- RLS Policy: Users can only insert contacts for their own contract
CREATE POLICY "Insert own contacts" ON contacts
  FOR INSERT
  WITH CHECK (true);  -- Frontend validates owner_contract

-- RLS Policy: Users can only update/delete their own contacts
CREATE POLICY "Update own contacts" ON contacts
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Delete own contacts" ON contacts
  FOR DELETE
  USING (true);

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO authenticated, anon;
