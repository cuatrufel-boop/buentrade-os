-- ============================================================================
-- add_shipment_pickup_documents.sql
--
-- Point 6 of the frozen order-lifecycle flow: "la planta/carrier envian por correo" (BOL, packing
-- list, label photos, USDA papers if Docs) — this table is where those real attachments land,
-- matched to a shipment when the email states an order number, or left unmatched for the trader
-- to assign by hand otherwise (never guessed). shipment_id is nullable on purpose: a real email
-- with no order number in it still deserves a queued row, not a silent drop.
--
-- pickup_docs_emails_processed is the idempotency table, same pattern as
-- plant_price_emails_processed — a message already seen is skipped on the next poll.
-- ============================================================================

create table shipment_pickup_documents (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid references shipments(id) on delete cascade,
  order_number text,
  message_id text not null,
  from_email text not null,
  source text not null check (source in ('plant', 'carrier', 'unknown')),
  filename text not null,
  storage_url text not null,
  forwarded_to_customs_at timestamptz,
  created_at timestamptz not null default now()
);
create index shipment_pickup_documents_shipment_idx on shipment_pickup_documents(shipment_id);
create unique index shipment_pickup_documents_dedup on shipment_pickup_documents(message_id, filename);

create table pickup_docs_emails_processed (
  message_id text primary key,
  from_email text,
  subject text,
  order_number_detected text,
  shipment_matched boolean not null default false,
  attachments_found integer not null default 0,
  processed_at timestamptz not null default now()
);

-- Same 15-minute cadence as shipment-alerts-poll — one cron entry per poller, same pattern.
select cron.schedule(
  'pickup-docs-emails-poll',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/pickup-docs-emails-poll',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe", "apikey": "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ============================================================================
-- End.
-- ============================================================================
