-- ============================================================================
-- 002_countries_cities_staging_only.sql
--
-- STAGING ONLY (project geqhjykbxvxugvnpnygn). Adds normalized country/city
-- catalogs, additive only — the existing `country`/`city` free-text columns
-- on suppliers/plants/providers/customers are untouched, nothing is deleted.
--
-- Countries: fixed, closed catalog (like packaging/temperature) — real
-- countries only, never invented. Seeded now with the real lanes the business
-- actually uses: origin US/Canada/Chile/Brazil, destination Mexico + LatAm.
-- Not the full 195-country UN list — deliberately scoped to what's real for
-- this business per the user's own instruction (2026-08-25).
--
-- Cities: NOT seeded. Same judgment-call discipline as products/customers —
-- grown one at a time as real suppliers/plants/customers name a real city,
-- always via a confirm step, never auto-created. Table + alias pattern built
-- now so that growth is just "insert one row + one alias," never a redesign.
-- ============================================================================

create table countries (
  id uuid primary key default gen_random_uuid(),
  iso2 text not null unique,
  iso3 text not null unique,
  name_es text not null,
  name_en text not null,
  created_at timestamptz not null default now()
);

create table country_aliases (
  id uuid primary key default gen_random_uuid(),
  raw_text text not null,
  country_id uuid not null references countries(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index country_aliases_raw_text_idx on country_aliases (lower(raw_text));

create table cities (
  id uuid primary key default gen_random_uuid(),
  country_id uuid not null references countries(id) on delete restrict,
  name text not null,
  created_at timestamptz not null default now(),
  unique (country_id, name)
);

create table city_aliases (
  id uuid primary key default gen_random_uuid(),
  raw_text text not null,
  city_id uuid not null references cities(id) on delete cascade,
  country_id uuid not null references countries(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index city_aliases_country_raw_text_idx on city_aliases (country_id, lower(raw_text));

alter table suppliers add column country_id uuid references countries(id);
alter table suppliers add column city_id uuid references cities(id);
alter table plants add column country_id uuid references countries(id);
alter table plants add column city_id uuid references cities(id);
alter table providers add column country_id uuid references countries(id);
alter table providers add column city_id uuid references cities(id);
alter table customers add column country_id uuid references countries(id);
alter table customers add column city_id uuid references cities(id);

insert into countries (iso2, iso3, name_es, name_en) values
  ('US', 'USA', 'Estados Unidos', 'United States'),
  ('CA', 'CAN', 'Canadá', 'Canada'),
  ('MX', 'MEX', 'México', 'Mexico'),
  ('CL', 'CHL', 'Chile', 'Chile'),
  ('BR', 'BRA', 'Brasil', 'Brazil'),
  ('GT', 'GTM', 'Guatemala', 'Guatemala'),
  ('HN', 'HND', 'Honduras', 'Honduras'),
  ('SV', 'SLV', 'El Salvador', 'El Salvador'),
  ('NI', 'NIC', 'Nicaragua', 'Nicaragua'),
  ('CR', 'CRI', 'Costa Rica', 'Costa Rica'),
  ('PA', 'PAN', 'Panamá', 'Panama'),
  ('CO', 'COL', 'Colombia', 'Colombia'),
  ('EC', 'ECU', 'Ecuador', 'Ecuador'),
  ('PE', 'PER', 'Perú', 'Peru'),
  ('BO', 'BOL', 'Bolivia', 'Bolivia'),
  ('PY', 'PRY', 'Paraguay', 'Paraguay'),
  ('UY', 'URY', 'Uruguay', 'Uruguay'),
  ('AR', 'ARG', 'Argentina', 'Argentina'),
  ('VE', 'VEN', 'Venezuela', 'Venezuela'),
  ('DO', 'DOM', 'República Dominicana', 'Dominican Republic');

-- ============================================================================
-- End of 002.
-- ============================================================================
