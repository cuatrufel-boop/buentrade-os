-- BUENTRADE Trading OS — Fase 5 (Quotes): sent-offer log + closed-deal orders
--
-- Design, approved by the user 2026-08-15:
-- 1. Nothing is saved while a trader is just exploring prices in Quotes — only
--    when an offer is actually SENT to a customer (Send Email/WhatsApp Offers,
--    or the per-customer buttons) does a row land in sent_offers, automatically,
--    with the exact numbers at that moment (a frozen snapshot, not a live
--    recalculation — later rate changes never alter a past offer).
-- 2. A sent offer can sit for hours/days before the customer confirms — that's
--    fine, it's a durable row in the DB, not live browser state. When the
--    trader later marks ONE specific sent offer "Ganada" (won), that single
--    action stamps a consecutive order_number onto it and spawns the PO/SO/FO
--    rows below. Offers that never get marked won just stay status='sent'
--    forever — harmless, cheap, and still searchable.
-- 3. purchase_orders (PO → plant), sales_orders (SO → customer), and
--    freight_orders (FO → carrier, only when freight is actually part of the
--    deal) are three separate documents from ONE closed deal, all sharing the
--    same order_number for traceability. freight_orders carries both
--    quoted_rate (frozen at close) and actual_rate (nullable, filled in later
--    once real crossing costs are known) — the whole reason this table exists
--    separately instead of just copying a number onto sales_orders.
--
-- Scope of this migration ONLY: create these 4 tables + 1 sequence + RLS +
-- policies + grants. No other table touched. No data inserted, no screens,
-- no wiring into quotes.html yet — that's the next step.

create sequence if not exists order_number_seq start 1;

create table if not exists sent_offers (
  id uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  sent_by text,
  channel text not null check (channel in ('email', 'whatsapp')),

  product_name text not null,
  product_spec text,

  plant_id uuid references plants(id) on delete set null,
  plant_name text not null,

  customer_id uuid references customers(id) on delete set null,
  customer_name text not null,

  -- Frozen snapshot of every number that went into this specific offer —
  -- never recalculated later, even if the underlying rates change.
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

  created_at timestamptz not null default now()
);

create index if not exists sent_offers_status_idx on sent_offers(status);
create index if not exists sent_offers_sent_at_idx on sent_offers(sent_at desc);
create index if not exists sent_offers_plant_idx on sent_offers(plant_id);
create index if not exists sent_offers_customer_idx on sent_offers(customer_id);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  sent_offer_id uuid not null references sent_offers(id) on delete cascade,
  plant_id uuid references plants(id) on delete set null,
  plant_name text not null,
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

create table if not exists sales_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  sent_offer_id uuid not null references sent_offers(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  customer_name text not null,
  product_name text not null,
  product_spec text,
  sale_price numeric(12,4),
  weight numeric(12,2) not null default 40000,
  total_sale numeric(14,2),
  delivery_dates jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'fulfilled', 'cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists freight_orders (
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

create index if not exists purchase_orders_order_number_idx on purchase_orders(order_number);
create index if not exists sales_orders_order_number_idx on sales_orders(order_number);
create index if not exists freight_orders_order_number_idx on freight_orders(order_number);

alter table sent_offers enable row level security;
alter table purchase_orders enable row level security;
alter table sales_orders enable row level security;
alter table freight_orders enable row level security;

create policy "authenticated_full_access_sent_offers" on sent_offers for all to authenticated using (true) with check (true);
create policy "authenticated_full_access_purchase_orders" on purchase_orders for all to authenticated using (true) with check (true);
create policy "authenticated_full_access_sales_orders" on sales_orders for all to authenticated using (true) with check (true);
create policy "authenticated_full_access_freight_orders" on freight_orders for all to authenticated using (true) with check (true);

grant usage on schema public to authenticated;
grant usage on sequence order_number_seq to authenticated;
grant select, insert, update, delete on sent_offers to authenticated;
grant select, insert, update, delete on purchase_orders to authenticated;
grant select, insert, update, delete on sales_orders to authenticated;
grant select, insert, update, delete on freight_orders to authenticated;
