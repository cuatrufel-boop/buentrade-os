-- ============================================================================
-- add_plant_price_emails_poll_cron.sql
--
-- Real incident 2026-09-09: Seaboard Foods sent a price-list email that sat unread for days
-- because plant-price-emails-poll (the Gmail ingestion pipeline) had NO automatic trigger —
-- confirmed in 20260906010000's own comment ("plant-price-emails-poll has no automatic trigger
-- either"). It only ever ran when someone manually invoked it. Same fix as shipment-alerts-poll:
-- pg_cron + pg_net (both already enabled by that migration), same 15-minute cadence.
-- ============================================================================

select cron.schedule(
  'plant-price-emails-poll',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/plant-price-emails-poll',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe", "apikey": "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe"}'::jsonb,
    body := '{"max_results": 20}'::jsonb
  );
  $$
);

-- ============================================================================
-- End.
-- ============================================================================
