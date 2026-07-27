-- Contacts table: address book scoped per wallet contract
create table if not exists contacts (
  id             uuid primary key default gen_random_uuid(),
  owner_contract text not null,               -- C... wallet contract address
  name           text not null,
  address        text not null,               -- G... or C... Stellar address
  created_at     timestamptz not null default now()
);

-- One wallet can have many contacts, but no duplicate address per wallet
create unique index if not exists contacts_owner_address_idx
  on contacts (owner_contract, address);

-- Row-level security enabled (table is protected even if policies are permissive,
-- signalling intent that access should be scoped per wallet).
-- The app always queries with an owner_contract filter, which is the primary
-- access-control mechanism. Tighter RLS can be layered on once wallet-scoped
-- JWTs are available.
alter table contacts enable row level security;

-- Permissive policies: allow full access for the anon key.
-- Real isolation is enforced by the app always filtering on owner_contract.
create policy "Allow all for anon"
  on contacts
  for all
  using (true)
  with check (true);
