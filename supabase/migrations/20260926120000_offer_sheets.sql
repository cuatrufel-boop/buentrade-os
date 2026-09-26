-- ============================================================================
-- 20260926120000_offer_sheets.sql
--
-- Offer Sheets, part 1 of 5 (approved 2026-09-26 — see the Quotes "Offer Sheet" design): one live sheet per product
-- being quoted. It remembers what the Quotes screen alone can't: WHICH customers the sheet is for, the delivery dates,
-- and WHICH plants were asked for a price and when — so that when a plant's price email lands, the system knows it
-- answers an open sheet and can flag it NEW and alert the trader.
--
-- Deliberately small. Everything else the sheet shows is already stored elsewhere and read live, never copied here:
--   * prices, price dates, pickup city, "doesn't produce"  → plant_products (current_price, price_date, location_id,
--     declined_at, last_requested_at)
--   * freight rates                                          → provider_rates
--   * what each customer already received                   → sent_offers (customer, plant, product, sale_per_lb, sent_at)
-- Additive only: no existing table or column is touched.
-- ============================================================================

create table offer_sheets (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  delivery_dates jsonb not null default '[]'::jsonb,
  -- 'open' while being worked; 'closed' once won or expired (same 10-day life as an offer).
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_reason text check (closed_reason in ('won', 'expired', 'manual')),
  created_by text,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  idempotency_key text unique
);
-- One open sheet per product at a time — reopening the same product continues the sheet instead of starting a second one.
create unique index offer_sheets_one_open_per_product on offer_sheets(product_id) where status = 'open';

-- Which customers this sheet is for (the "same customers" every Lista actualizada goes back to).
create table offer_sheet_customers (
  sheet_id uuid not null references offer_sheets(id) on delete cascade,
  customer_id uuid not null references customers(id),
  added_at timestamptz not null default now(),
  primary key (sheet_id, customer_id)
);

-- Which plants this sheet asked for a price, and when. answered_at is set when that plant's price lands after asked_at;
-- "No reply" (48h) is derived from asked_at at read time, never stored.
create table offer_sheet_plants (
  sheet_id uuid not null references offer_sheets(id) on delete cascade,
  plant_id uuid not null references plants(id),
  asked_at timestamptz,
  reminded_at timestamptz,
  answered_at timestamptz,
  primary key (sheet_id, plant_id)
);
create index offer_sheet_plants_plant_idx on offer_sheet_plants(plant_id) where answered_at is null;

grant select, insert, update, delete on offer_sheets, offer_sheet_customers, offer_sheet_plants to api_service;
