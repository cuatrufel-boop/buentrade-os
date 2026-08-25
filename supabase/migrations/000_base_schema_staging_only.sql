-- ============================================================================
-- 000_base_schema_staging_only.sql  (v2 — corrected against the real history)
--
-- STAGING ONLY (project geqhjykbxvxugvnpnygn). Never run against production
-- (zhtvimnaeogywmjuomiz). No production connection was used or reconstructed
-- to build this — the correction below came entirely from reading this
-- repo's own local files (database/*.sql, the real migration history) plus
-- the live schema read already done during today's audit (before the
-- production connection was deleted).
--
-- v1 of this file was reconstructed only from code usage + memory and had
-- real gaps, found by actually reading database/*.sql: missing UNIQUE
-- constraints on plant_products/provider_rates/exchange_rates, missing CHECK
-- constraints on provider_roles/provider_rates/sent_offers/purchase_orders/
-- sales_orders/freight_orders, a missing `status` column on 3 order tables,
-- wrong numeric precision throughout, a missing order-number sequence +
-- function, and suppliers reduced to just id+name when it actually has 12
-- real fields. All corrected below, each one traceable to a specific file.
--
-- Columns confirmed live during today's audit (before production access was
-- removed) but with NO matching file in database/ — meaning they were added
-- directly at some point, not saved as a migration: products.name_en/
-- subcategory_en/full_name_en/full_name_es, plants.email_cc/whatsapp_cc/
-- logo_url/logo_url_dark, providers.email_cc/whatsapp_cc, sent_offers.
-- product_id/product_name_es/product_spec_es, sales_orders.product_id/
-- product_name_es/product_spec_es. Kept here (real, in use today) but
-- flagged so this gap in the repo's own history is visible, not hidden.
--
-- 7 tables still deliberately excluded, now with the exact reason each one
-- stopped being live, not just "unused":
--   - cost_types, incoterms: created in master_data_schema.sql, never wired
--     to any screen — incoterms even has a code comment saying so directly.
--   - freight_carriers: superseded by providers/provider_roles.
--   - trucking: explicitly a temporary table — merge_trucking_into_carriers.sql
--     folds it INTO freight_carriers (itself now also dead), then trucking
--     was never touched again.
--   - plant_location_contacts, quote_requests, quote_request_items: real,
--     deliberately designed tables (see create_plant_location_contacts.sql)
--     that were built but never actually wired into any of the 7 HTML pages.
--
-- Nothing in this file is executed yet. Shown for review only.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Catalogs
-- ---------------------------------------------------------------------------
create table packaging (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,      -- master_data_schema.sql
  name_en text,                   -- fix_temp_packaging_bilingual.sql
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table temperature (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  name_en text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Suppliers / Plants
-- ---------------------------------------------------------------------------
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text,
  state text,
  city text,
  contact_name text,
  email text,
  phone text,
  website text,
  notes text,
  avg_response_time text,
  payment_terms text,
  required_documentation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table plants (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id) on delete restrict,
  name text not null,
  country text,
  state text,
  city text,
  address text,
  internal_code text,
  contact_name text,
  email text,
  email_cc text,      -- confirmed live, no source file found
  phone text,
  whatsapp text,       -- add_whatsapp_to_plants.sql
  whatsapp_cc text,    -- confirmed live, no source file found
  business_hours text,
  avg_loading_time text,
  avg_response_time text,          -- merge_suppliers_into_plants.sql
  document_cost numeric(12,2),
  avg_freight_to_border numeric(12,2),
  docs_included boolean,           -- confirmed live, no source file found
  payment_terms text,              -- merge_suppliers_into_plants.sql
  required_documentation text,     -- merge_suppliers_into_plants.sql
  website text,                    -- merge_suppliers_into_plants.sql
  notes text,
  internal_notes text,
  logo_url text,        -- confirmed live, no source file found
  logo_url_dark text,   -- confirmed live, no source file found
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Providers (freight/customs — separate concept from suppliers/plants)
-- ---------------------------------------------------------------------------
create table providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text,
  city text,
  phone text,
  contact_name text,
  email text,
  email_cc text,        -- confirmed live, no source file found
  whatsapp_cc text,     -- confirmed live, no source file found
  notes text,
  mc_number text,       -- add_carrier_mc_dot_numbers.sql
  dot_number text,      -- add_carrier_mc_dot_numbers.sql
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table provider_roles (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  role text not null check (role in ('carrier', 'freight_forwarder', 'customs_broker')),
  created_at timestamptz not null default now(),
  unique (provider_id, role)
);

create table provider_rates (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers(id) on delete cascade,
  plant_id uuid references plants(id) on delete set null, -- add_plant_id_to_provider_rates.sql
  service_type text not null check (service_type in (
    'us_freight', 'mexican_freight', 'customs',
    'tramite_aduanal', 'bodega_americana', 'lumper_fee', 'inbond_release' -- expand_provider_rates_customs_types.sql
  )),
  origin text not null default '',
  destination text not null default '',
  rate numeric(12,2) not null,
  currency text not null default 'USD',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, service_type, origin, destination)
);

-- ---------------------------------------------------------------------------
-- Products / Plant<->Product
-- ---------------------------------------------------------------------------
create table products (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  name text not null,
  name_en text,             -- confirmed live, no source file found
  subcategory text,
  subcategory_en text,      -- confirmed live, no source file found
  brand text,
  packaging_id uuid references packaging(id),
  temperature_id uuid references temperature(id),
  presentation text,
  unit_of_measure text,
  standard_weight numeric(12,2),
  origin text,
  documents_included text,
  documents_excluded text,
  commercial_notes text,
  photo_url text,           -- setup_product_photos.sql
  spec_url text,            -- confirmed live, no source file found
  full_name_en text,        -- confirmed live, no source file found
  full_name_es text,        -- confirmed live, no source file found
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table plant_products (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  current_price numeric(12,4),
  price_currency text default 'USD',
  price_date date,
  availability text,
  docs_included boolean,     -- confirmed live, no source file found
  notes text,
  last_requested_at timestamptz, -- confirmed live, no source file found
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plant_id, product_id)
);

create table plant_product_aliases (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  raw_text text not null,
  created_at timestamptz not null default now(),
  unique (plant_id, raw_text)
);

create table plant_term_aliases (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id) on delete cascade,
  term text not null,
  meaning_type text not null check (meaning_type in ('temperature', 'packaging')),
  meaning_id uuid not null,
  unique (plant_id, term, meaning_type)
);

create table plant_locations (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id) on delete cascade,
  location_name text not null,
  protein text,
  freight_to_border_usd numeric(12,2),
  delivered_by_plant boolean,
  contact_name text,
  phone text,
  email text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table plant_location_contacts (
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

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
create table customers (
  id uuid primary key default gen_random_uuid(),
  trade_name text not null,
  legal_name text,
  country text,
  state text,
  city text,
  address text,
  contact_name text,
  contact_role text,
  email text,
  email_cc text,
  phone text,
  whatsapp text,
  whatsapp_cc text,
  website text,
  notes text,
  preferred_currency text,
  usual_delivery_type text,
  usual_destination text,
  usual_incoterm_id uuid, -- FK to incoterms not created: that table is excluded (never read from live)
  payment_days integer,
  payment_method text,
  preferred_exchange_rate_mode text,
  payments_contact_name text,        -- add_payments_contact.sql
  payments_contact_email text,       -- add_payments_contact.sql
  payments_contact_phone text,       -- add_payments_contact.sql
  payments_contact_whatsapp text,    -- add_payments_contact.sql
  customs_agency_provider_id uuid references providers(id) on delete set null, -- add_customs_agency_to_customers.sql
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table customer_products (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (customer_id, product_id)
);

-- ---------------------------------------------------------------------------
-- Exchange rates
-- ---------------------------------------------------------------------------
create table exchange_rates (
  id uuid primary key default gen_random_uuid(),
  rate_date date not null,
  from_currency text not null default 'USD',
  to_currency text not null default 'MXN',
  rate numeric(12,6) not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique (rate_date, from_currency, to_currency)
);

-- ---------------------------------------------------------------------------
-- Offers / orders pipeline
-- ---------------------------------------------------------------------------
create sequence order_number_seq start 1;

create or replace function next_order_number()
returns text
language sql
as $$
  select 'BT-' || lpad(nextval('order_number_seq')::text, 4, '0');
$$;

create table sent_offers (
  id uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  sent_by text,
  channel text not null check (channel in ('email', 'whatsapp')),
  product_id uuid references products(id),           -- confirmed live, no source file found
  product_name text not null,
  product_name_es text,                                -- confirmed live, no source file found
  product_spec text,
  product_spec_es text,                                -- confirmed live, no source file found
  plant_id uuid references plants(id) on delete set null,
  plant_name text not null,
  customer_id uuid references customers(id) on delete set null,
  customer_name text not null,
  purchase_price numeric(12,4),
  us_freight_rate_id uuid references provider_rates(id) on delete set null,
  us_freight_amount numeric(12,2) not null default 0,
  docs_on boolean not null default false,
  inspection_amount numeric(12,2) not null default 0,
  mexican_dest_rate_id uuid references provider_rates(id) on delete set null,
  mexican_freight_mxn numeric(12,2),
  customs_agency_provider_id uuid references providers(id) on delete set null,
  tramite_aduanal_amount numeric(12,2) not null default 0,
  bodega_americana_amount numeric(12,2) not null default 0,
  extra_fields jsonb not null default '[]'::jsonb,
  weight numeric(12,2) not null default 40000,
  cost_per_lb numeric(12,4),
  sale_per_lb numeric(12,4),
  total_cost numeric(14,2),
  total_sale numeric(14,2),
  delivery_dates jsonb not null default '[]'::jsonb,
  status text not null default 'sent' check (status in ('sent', 'won', 'lost')),
  order_number text,
  won_at timestamptz,
  won_by text,
  negotiation_log jsonb not null default '[]'::jsonb, -- add_negotiation_log.sql
  created_at timestamptz not null default now()
);

create index sent_offers_status_idx on sent_offers(status);
create index sent_offers_sent_at_idx on sent_offers(sent_at desc);
create index sent_offers_plant_idx on sent_offers(plant_id);
create index sent_offers_customer_idx on sent_offers(customer_id);

create table purchase_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  sent_offer_id uuid not null references sent_offers(id) on delete cascade,
  plant_id uuid references plants(id) on delete set null,
  plant_name text not null,
  product_id uuid references products(id),
  product_name text not null,
  product_spec text,
  purchase_price numeric(12,4),
  weight numeric(12,2) not null default 40000,
  total_cost numeric(14,2),
  docs_on boolean not null default false,
  delivery_dates jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'fulfilled', 'cancelled')),
  created_at timestamptz not null default now()
);

create table sales_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  sent_offer_id uuid not null references sent_offers(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  customer_name text not null,
  product_id uuid references products(id),            -- confirmed live, no source file found
  product_name text not null,
  product_spec text,
  product_name_es text,                                  -- confirmed live, no source file found
  product_spec_es text,                                  -- confirmed live, no source file found
  sale_price numeric(12,4),
  weight numeric(12,2) not null default 40000,
  total_sale numeric(14,2),
  delivery_dates jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'fulfilled', 'cancelled')),
  created_at timestamptz not null default now()
);

create table freight_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  sent_offer_id uuid not null references sent_offers(id) on delete cascade,
  carrier_provider_id uuid references providers(id) on delete set null,
  origin text,
  destination text,
  quoted_rate numeric(12,2),
  actual_rate numeric(12,2),
  currency text not null default 'USD',
  status text not null default 'open' check (status in ('open', 'fulfilled', 'cancelled')),
  created_at timestamptz not null default now()
);

create index purchase_orders_order_number_idx on purchase_orders(order_number);
create index sales_orders_order_number_idx on sales_orders(order_number);
create index freight_orders_order_number_idx on freight_orders(order_number);

create table order_extra_costs (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  sent_offer_id uuid references sent_offers(id) on delete cascade,
  cost_type text not null,
  amount numeric(12,2) not null,
  notes text,
  created_at timestamptz not null default now()
);

create index order_extra_costs_order_number_idx on order_extra_costs(order_number);

-- ============================================================================
-- End of 000 (v2). NOT executed. Waiting for review + explicit authorization.
-- ============================================================================
