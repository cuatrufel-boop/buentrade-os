-- ============================================================================
-- add_plant_payment_alert_tracking.sql
--
-- Real gap explained by the user 2026-09-06: paying the plant + getting the release number (the
-- carrier needs it to physically pick up the load) is a separate, EARLIER step than pickup-day
-- logistics — closer to right after the order is won, not the day before pickup. Exact cadence
-- still unconfirmed by the user ("te confirmo"); this is just the dedup column for that alert.
-- ============================================================================

alter table shipments add column plant_payment_alert_sent_at timestamptz;

-- ============================================================================
-- End.
-- ============================================================================
