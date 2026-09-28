-- Pay & Receive, 2026-09-28 ("los pagos a customs y a carriers tienen que ser contrastados con
-- facturas que nos envian ellos... tiene que cuadrar, toca revisar uno por uno y llamarlos a
-- preguntar hasta que podamos dar visto bueno y poder pagar"):
--   - a carrier / customs agency paid AT DELIVERY sends one invoice per load
--   - one paid at 30 DAYS sends one invoice for the loads of that period
-- The invoice is entered with its number, total and PDF, linked to the loads it covers; it stays
-- 'in_review' (with the trader's call notes) until its total equals the sum of our bills for those
-- loads, then it is approved — and only an approved invoice can be paid (enforced server-side).
create table provider_invoices (
  id uuid primary key default gen_random_uuid(),
  payee_name text not null,
  kind text not null check (kind in ('customs', 'freight')),
  invoice_number text not null,
  invoice_total numeric not null check (invoice_total > 0),
  file_name text,
  storage_path text,
  status text not null default 'in_review' check (status in ('in_review', 'approved')),
  created_by text not null,
  created_at timestamptz not null default now(),
  approved_by text,
  approved_at timestamptz,
  idempotency_key text unique
);
create table provider_invoice_loads (
  invoice_id uuid not null references provider_invoices(id) on delete cascade,
  shipment_id uuid not null references shipments(id),
  amount numeric not null,
  primary key (invoice_id, shipment_id)
);
create table provider_invoice_notes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references provider_invoices(id) on delete cascade,
  note text not null,
  actor text not null,
  created_at timestamptz not null default now(),
  idempotency_key text unique
);
alter table shipment_money_records add column invoice_id uuid references provider_invoices(id);
grant select, insert, update on provider_invoices to api_service;
grant select, insert, delete on provider_invoice_loads to api_service;
grant select, insert on provider_invoice_notes to api_service;
insert into storage.buckets (id, name, public) values ('provider-invoices', 'provider-invoices', false) on conflict (id) do nothing;
