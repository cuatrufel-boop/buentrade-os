-- ============================================================================
-- add_release_number_emails_processed.sql
--
-- Real ask 2026-09-14: "ese release number cuando lo responde la planta debe actualizar" — the
-- payment-confirmation email (confirmPlantPaymentSent) already asks the plant's Payments Contact
-- for the release number in the subject/body, but capturing the value required the trader to read
-- the reply themselves and type it into a prompt() (recordReleaseNumber). Same pattern as
-- pickup_docs_emails_processed: an idempotency table so release-number-emails-poll never reads
-- the same message twice.
-- ============================================================================

create table release_number_emails_processed (
  message_id text primary key,
  from_email text,
  subject text,
  order_number_detected text,
  release_number_extracted text,
  shipment_updated boolean not null default false,
  processed_at timestamptz not null default now()
);

-- Same 15-minute cadence as pickup-docs-emails-poll/shipment-alerts-poll, one cron entry per poller.
select cron.schedule(
  'release-number-emails-poll',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/release-number-emails-poll',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe", "apikey": "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ============================================================================
-- End.
-- ============================================================================
