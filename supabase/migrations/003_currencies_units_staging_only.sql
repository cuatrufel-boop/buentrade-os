-- ============================================================================
-- 003_currencies_units_staging_only.sql
--
-- STAGING ONLY (project geqhjykbxvxugvnpnygn). Two more fixed, closed
-- catalogs — same family as packaging/temperature (dropdown-picked, never
-- free-typed by a plant/customer), so no alias table is needed here, unlike
-- countries/cities which get typed freely inside real price lists/emails.
--
-- Every existing text column that already held a currency or a unit
-- (provider_rates.currency, products.unit_of_measure, plant_products.
-- price_currency, customers.preferred_currency, exchange_rates.from_currency/
-- to_currency, freight_orders.currency) keeps its raw text exactly as-is —
-- a nullable *_id column is added alongside each one, additive only, same
-- pattern as country_id/city_id in 002.
--
-- Scope: USD/MXN only and LB/KG/UN only — matches the real US-MX lane the
-- business is starting with (2026-08-25), not a maximal world list.
-- ============================================================================

create table currencies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_es text not null,
  name_en text not null,
  symbol text not null,
  created_at timestamptz not null default now()
);

create table units (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_es text not null,
  name_en text not null,
  created_at timestamptz not null default now()
);

alter table provider_rates add column currency_id uuid references currencies(id);
alter table plant_products add column price_currency_id uuid references currencies(id);
alter table customers add column preferred_currency_id uuid references currencies(id);
alter table exchange_rates add column from_currency_id uuid references currencies(id);
alter table exchange_rates add column to_currency_id uuid references currencies(id);
alter table freight_orders add column currency_id uuid references currencies(id);

alter table products add column unit_id uuid references units(id);

insert into currencies (code, name_es, name_en, symbol) values
  ('USD', 'Dólar estadounidense', 'US Dollar', '$'),
  ('MXN', 'Peso mexicano', 'Mexican Peso', '$');

insert into units (code, name_es, name_en) values
  ('LB', 'Libra', 'Pound'),
  ('KG', 'Kilogramo', 'Kilogram'),
  ('UN', 'Unidad', 'Unit');

-- ============================================================================
-- End of 003.
-- ============================================================================
