-- ============================================================================
-- expire_stale_offers.sql
--
-- Real ask 2026-09-08: "en las offers... mas de una semana ya son obsoletas... en que momento las
-- vamos borrando y como para que no se llene eso de mucha data" -> recommended NOT deleting (real
-- negotiation history is worth keeping for reference/audit) and instead auto-expiring stale ones
-- out of the daily Pending view. Approved: "si hazlo que se expiren las ofertas en 10 dias."
--
-- 'expired' is its own status, never folded into 'lost' — a real competitive loss (customer said
-- no, we lost the bid) is a different business event from "nobody ever replied," and lumping them
-- together would quietly corrode the win-rate stat (renderStats() in offers.html only counts
-- won/lost). Same cron pattern as shipment-alerts-poll (20260906010000): pg_cron + pg_net already
-- enabled by that migration, just a new schedule entry here.
-- ============================================================================

alter table sent_offers drop constraint sent_offers_status_check;
alter table sent_offers add constraint sent_offers_status_check check (status in ('sent', 'won', 'lost', 'expired'));

select cron.schedule(
  'sent-offers-expire-stale',
  '0 8 * * *',
  $$
  select net.http_post(
    url := 'https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/sent-offers-expire-stale',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe", "apikey": "sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ============================================================================
-- End.
-- ============================================================================
