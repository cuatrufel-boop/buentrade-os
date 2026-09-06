-- ============================================================================
-- add_shipment_alert_tracking_and_cron.sql
--
-- Real ask 2026-09-06: "una notificacion donde yo le de ok y se ejecute" — this is the engine
-- that decides WHEN to fire one. Confirmed live: this project had NO recurring scheduler at all
-- (cron.job didn't exist, no pg_cron enabled) — plant-price-emails-poll has no automatic trigger
-- either. Enabling pg_cron + pg_net here (Supabase's own "Cron" feature) so shipment-alerts-poll
-- actually runs on its own, every 15 minutes, calling the function via net.http_post.
--
-- Alert-tracking columns are additive on shipments, one per condition, each nullable so "not
-- alerted yet" is just null — dedup is "have I already sent this one," not a separate table.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

alter table shipments add column pre_pickup_alert_sent_at timestamptz;
alter table shipments add column missed_pickup_alert_sent_at timestamptz;
alter table shipments add column pickup_docs_alert_sent_at timestamptz;
alter table shipments add column border_overdue_alert_sent_at timestamptz;

select cron.schedule(
  'shipment-alerts-poll',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/shipment-alerts-poll',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe", "apikey": "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ============================================================================
-- End.
-- ============================================================================
