-- ============================================================================
-- 20260922100000_create_load_closed_notifications.sql
--
-- Real ask 2026-09-22 ("cuando cierro una carga, avisarle a otros clientes que compran ese
-- producto"): logs every real "we just closed this load, here's the price/destination/date" ping
-- sent to a customer OTHER than the one who actually bought — never the buyer, never invented,
-- one row per real send. Two jobs this table does:
--   1. Idempotency: unique (customer_id, product_id, order_number) with `on conflict do nothing`
--      — clicking the notify action twice for the same closed order never double-sends the same
--      customer the same ping.
--   2. Frequency cap: the edge function that lists candidates reads recent rows here (any
--      order_number) to skip a customer already pinged for this product in the last 7 days — real
--      ask from the same conversation ("no quiero que el cliente se canse de tanta data"), so a
--      week with 5 closed loads on one product still reaches each customer at most once.
-- ============================================================================

create table load_closed_notifications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  order_number text not null,
  channel text not null check (channel in ('email', 'whatsapp')),
  sent_by text,
  sent_at timestamptz not null default now(),
  unique (customer_id, product_id, order_number)
);

create index load_closed_notifications_recency_idx on load_closed_notifications(customer_id, product_id, sent_at);

-- ============================================================================
-- End of 20260922100000.
-- ============================================================================
