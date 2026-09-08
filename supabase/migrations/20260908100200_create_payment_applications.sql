-- Collections module. "debe poderse impactar cada cliente cuando entre un pago... deben poderse
-- liberar en el sistema" — a real ledger of every payment applied against a shipment, not just a
-- mutated running balance, so there's a real audit trail (and "registrar metodo/referencia de
-- pago", the approved suggestion, has somewhere to live). One customer payment can span several
-- shipments (oldest-open-invoice-first waterfall) — each row here is one shipment's slice of that
-- payment, not the whole payment.
create table payment_applications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  shipment_id uuid not null references shipments(id),
  order_number text not null,
  amount_applied numeric not null,
  payment_method text,
  payment_reference text,
  applied_at timestamptz not null default now(),
  actor text not null,
  idempotency_key text unique
);

create index payment_applications_shipment_id_idx on payment_applications(shipment_id);
create index payment_applications_customer_id_idx on payment_applications(customer_id);
