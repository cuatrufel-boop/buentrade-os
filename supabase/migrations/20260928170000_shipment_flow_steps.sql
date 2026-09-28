-- Pay & Receive flow (2026-09-28, "un mismo flujo de pay and rec como el de orders... sino
-- llevamos un flujo obligatorio el proceso se vuelve OPCIONAL"): the steps of the money flow that
-- are not a payment — the trader confirmed the load's real freight cost (base + surcharges, or no
-- surcharges) and sent the customer the day-29 payment reminder. Money steps live in
-- shipment_money_records / payment_applications; these two close the rest of the flow.
create table shipment_flow_steps (
  shipment_id uuid not null references shipments(id),
  step text not null check (step in ('freight_confirmed', 'customer_reminder_sent')),
  done_at timestamptz not null default now(),
  actor text not null,
  detail jsonb,
  idempotency_key text unique,
  primary key (shipment_id, step)
);
grant select, insert on shipment_flow_steps to api_service;
