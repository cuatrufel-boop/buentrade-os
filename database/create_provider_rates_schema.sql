-- BUENTRADE Trading OS — provider_rates (foundation only, no data)
--
-- One normalized rate table for all three provider services, discriminated
-- by service_type — same pattern already used for provider_roles instead of
-- one table per role. origin/destination are plain text, not FKs into
-- plants/plant_locations (explicitly not the source for this new
-- structure). Mexican Freight stays stored in USD; conversion to MXN
-- happens later via the existing exchange-rate logic in trading-tool.html
-- — nothing here does that conversion.
--
-- Scope of this migration ONLY: create provider_rates + RLS + policy +
-- grants. No other table touched. No data inserted.

create table if not exists provider_rates (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  service_type text not null check (service_type in ('us_freight', 'mexican_freight', 'customs')),
  origin text not null default '',
  destination text not null default '',
  rate numeric(12,2) not null,
  currency text not null default 'USD',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- origin/destination default to '' (never null) specifically so this
  -- constraint also catches duplicate 'customs' rows, which don't use
  -- either field — NULL <> NULL in a unique index, '' = '' does.
  unique (provider_id, service_type, origin, destination)
);

alter table provider_rates enable row level security;

create policy "authenticated_full_access_provider_rates" on provider_rates for all to authenticated using (true) with check (true);

grant usage on schema public to authenticated;
grant select, insert, update, delete on provider_rates to authenticated;
