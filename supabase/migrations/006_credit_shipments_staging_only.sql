-- ============================================================================
-- 006_credit_shipments_staging_only.sql
--
-- STAGING ONLY (project geqhjykbxvxugvnpnygn). Two connected pieces the trader
-- described 2026-08-25: a per-customer credit limit (exposure control — "no
-- me puedo pasar de ese monto hasta que pague"), and shipment tracking from
-- "won" through delivery through payment, which is what actually releases
-- that credit ("en el momento que el cliente paga el sistema debería liberar
-- ese monto para venderle más").
--
-- Additive only, same pattern as every migration so far.
-- ============================================================================

alter table customers add column credit_limit numeric(14,2);

create table shipments (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  sent_offer_id uuid not null references sent_offers(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  sale_amount numeric(14,2),
  status text not null default 'scheduled' check (status in ('scheduled', 'picked_up', 'in_transit', 'delivered')),
  carrier_provider_id uuid references providers(id) on delete set null,
  pickup_date date,
  picked_up_at timestamptz,
  border_delivery_date date,
  delivered_at timestamptz,
  payment_due_date date,
  paid_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shipments_customer_idx on shipments(customer_id);
create index shipments_status_idx on shipments(status);
create index shipments_order_number_idx on shipments(order_number);

create table shipment_events (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id) on delete cascade,
  event_type text not null check (event_type in ('scheduled', 'picked_up', 'in_transit_update', 'arriving_soon', 'delivered')),
  at timestamptz not null default now(),
  location text,
  notes text,
  customer_notified boolean not null default false,
  customer_notified_at timestamptz,
  notified_channel text check (notified_channel in ('email', 'whatsapp')),
  created_at timestamptz not null default now()
);
create index shipment_events_shipment_idx on shipment_events(shipment_id);

-- A visible feed on the customer's own profile — "notificaciones importantes en el perfil de ese
-- cliente" (payment received / credit freed up, credit-limit warnings, shipment milestones worth
-- surfacing there directly, not just buried in shipment_events).
create table customer_notifications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  type text not null,
  message text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index customer_notifications_customer_idx on customer_notifications(customer_id);

-- ============================================================================
-- End of 006.
-- ============================================================================
