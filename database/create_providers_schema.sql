-- BUENTRADE Trading OS — shared Provider/Company entity (foundation only)
--
-- One company can exist ONCE as a provider and hold multiple roles
-- (Carrier / Freight Forwarder / Customs Broker) via a normalized
-- relationship table, instead of a multi-select text field, so new
-- roles can be added later without changing the providers table shape.
--
-- Scope of this migration ONLY:
--   - create providers
--   - create provider_roles
--   - RLS + policies + grants, same pattern as every other table
--
-- Explicitly NOT done here (future migrations):
--   - no rates/services table
--   - no changes to freight_carriers, suppliers, plants, plant_locations
--   - no data migrated or duplicated from existing tables
--   - no UI

create table if not exists providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text,
  city text,
  phone text,
  contact_name text,
  email text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- role is constrained to the 3 supported values today; adding a role later
-- means relaxing this check (or moving to a small lookup table if the list
-- grows), never a structural change to providers or provider_roles itself.
create table if not exists provider_roles (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  role text not null check (role in ('carrier', 'freight_forwarder', 'customs_broker')),
  created_at timestamptz not null default now(),
  unique (provider_id, role)
);

alter table providers enable row level security;
alter table provider_roles enable row level security;

create policy "authenticated_full_access_providers" on providers for all to authenticated using (true) with check (true);
create policy "authenticated_full_access_provider_roles" on provider_roles for all to authenticated using (true) with check (true);

grant usage on schema public to authenticated;
grant select, insert, update, delete on providers to authenticated;
grant select, insert, update, delete on provider_roles to authenticated;
