-- ============================================================================
-- 20260925140000_market_flash_email_inbox.sql
--
-- Market Flash by email: the bulletin PDF arrives as an attachment in the same Gmail inbox the other pollers read.
-- Every candidate message is recorded here exactly once (message_id is the idempotency key), so nothing is invisible:
--   pending   → the PDF was downloaded and its text read; `items` waits for the second step (kept in a separate
--               invocation so the heavy PDF read and the bulletin processing never share one compute budget)
--   ingested  → became (or already was) a bulletin
--   rejected  → not processed, with the reason (sender not allowed, sender not authenticated, no PDF, not a bulletin…)
-- ============================================================================
create table market_flash_email_inbox (
  message_id text primary key,
  from_email text,
  subject text,
  status text not null check (status in ('pending', 'ingested', 'rejected')),
  reason text,
  file_hash text,
  items jsonb,
  bulletin_id uuid references market_flash_bulletins(id) on delete set null,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index market_flash_email_inbox_status_idx on market_flash_email_inbox(status);
grant select, insert, update, delete on market_flash_email_inbox to api_service;

select cron.schedule(
  'market-flash-emails-poll',
  '*/15 * * * *',
  $cron$
  select net.http_post(
    url := 'https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/price-history-search',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe", "apikey": "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe"}'::jsonb,
    body := '{"poll_market_flash_emails": {}}'::jsonb
  );
  $cron$
);
