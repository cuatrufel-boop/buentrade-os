-- Pay & Receive (Collections + Payments merged, approved 2026-09-28): every money movement of a
-- load that is NOT a customer paying an invoice (that one stays in payment_applications) and is
-- NOT an Orders step (plant payment / Summar wire stay on shipments.plant_paid_at /
-- summar_payment_sent_at):
--   - freight            OUT  we pay the carrier, at delivery
--   - customs            OUT  we pay customs / inspection, at delivery
--   - summar_remanente   IN   Summar pays us the 20% of the sale (less its fee), at delivery
-- One row per load slice of a payment (payment_batch_id groups one bank movement across loads,
-- same shape as payment_applications). `settles` = this record closes that item: true when the
-- trader records the item itself (the real amount replaces the estimate), false for a partial
-- slice of a bigger payment.
create table shipment_money_records (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id),
  order_number text not null,
  kind text not null check (kind in ('freight', 'customs', 'summar_remanente')),
  direction text not null check (direction in ('in', 'out')),
  party_name text,
  amount numeric not null check (amount > 0),
  settles boolean not null default true,
  bank_entry_date date not null,
  account text not null check (account in ('Buentrade', 'Summar')),
  payment_method text,
  payment_reference text,
  payment_batch_id uuid not null,
  actor text not null,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  check ((kind = 'summar_remanente') = (direction = 'in'))
);
create index shipment_money_records_shipment on shipment_money_records (shipment_id);

grant select, insert on shipment_money_records to api_service;
