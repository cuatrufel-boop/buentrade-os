-- BUENTRADE Trading OS — per-shift / per-role contacts for a plant location
--
-- plant_locations has a single contact_name/phone, which isn't enough for
-- real plant contact sheets (multiple shift contacts + a separate warehouse
-- manager, each with their own phone). This normalizes that instead of
-- cramming multiple names into one text field.

create table if not exists plant_location_contacts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references plant_locations(id) on delete cascade,
  name text not null,
  role text,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table plant_location_contacts enable row level security;

create policy "authenticated_full_access_plant_location_contacts" on plant_location_contacts for all to authenticated using (true) with check (true);

grant usage on schema public to authenticated;
grant select, insert, update, delete on plant_location_contacts to authenticated;
