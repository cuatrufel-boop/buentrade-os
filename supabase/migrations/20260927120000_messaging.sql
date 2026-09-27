-- ============================================================================
-- 20260927120000_messaging.sql
--
-- Messaging (approved 2026-09-27 from the prototype): every morning the trader sees, per client, every relevant thing
-- there is to tell him — his buying cycle, what he told us (personal notes), the Market Flash facts that touch his
-- products, and what we still don't know (his monthly volume) — each as a ready-written message in the trader's own
-- style. The trader picks which one, edits it if he wants and sends it. Nothing is ever sent automatically.
--
-- What already exists and is read live, never copied here:
--   * monthly volume          → customer_products.frequency_days + loads_per_cycle (what the client buys from ALL his
--                               suppliers — the trader's stated figure, not our own sales)
--   * loads from us           → sales_orders.delivery_dates
--   * Market Flash facts      → market_flash_bullets (+ market_flash_bullet_sends: a bullet reaches a client once)
-- Additive only: the one existing table touched gets one nullable column (customers.business_type_id).
-- ============================================================================

-- The trader's own business categories for clients (Distributor, Processor, …). Starts EMPTY on purpose: the list is
-- the trader's to give, never invented.
create table business_types (
  id uuid primary key default gen_random_uuid(),
  name_en text not null unique,
  created_at timestamptz not null default now()
);
alter table customers add column business_type_id uuid references business_types(id);

-- What the client told the trader (his son started university, he's building a plant…). Relationship memory: it
-- becomes a message option until the trader has used it.
create table customer_notes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  note text not null check (length(trim(note)) > 0),
  created_by text,
  created_at timestamptz not null default now(),
  idempotency_key text unique
);
create index customer_notes_customer_idx on customer_notes(customer_id, created_at desc);

-- Every message the trader actually sent from Messaging. `draft` is what the system proposed and `message` what the
-- trader really sent — the difference is how the system learns his way of writing (only from him).
-- request_* is filled when, in Quotes, the trader confirms a client's product request came from this message.
create table customer_messages (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  reason_kind text not null check (reason_kind in ('cycle', 'ask_volume', 'personal', 'market')),
  reason_key text not null,
  product_id uuid references products(id),
  note_id uuid references customer_notes(id) on delete set null,
  bullet_ids jsonb not null default '[]'::jsonb,
  draft text,
  message text not null check (length(trim(message)) > 0),
  channel text not null check (channel in ('whatsapp', 'email')),
  sent_by text,
  sent_at timestamptz not null default now(),
  request_linked_at timestamptz,
  request_linked_by text,
  request_product_id uuid references products(id),
  origin_dismissed_at timestamptz,
  idempotency_key text unique
);
create index customer_messages_customer_idx on customer_messages(customer_id, sent_at desc);
create index customer_messages_product_idx on customer_messages(product_id, sent_at desc);

-- The written draft for each (client, reason), kept for the day so reopening the screen doesn't rewrite it.
create table customer_message_drafts (
  customer_id uuid not null references customers(id) on delete cascade,
  reason_key text not null,
  draft text not null,
  created_at timestamptz not null default now(),
  primary key (customer_id, reason_key)
);

grant select, insert, update, delete on business_types, customer_notes, customer_messages, customer_message_drafts to api_service;
grant update (business_type_id) on customers to api_service;
