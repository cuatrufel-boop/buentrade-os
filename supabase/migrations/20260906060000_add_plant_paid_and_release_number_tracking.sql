-- ============================================================================
-- add_plant_paid_and_release_number_tracking.sql
--
-- Real correction 2026-09-06: paying the plant and asking for the release number are TWO separate
-- steps, not one message that asks the plant to self-report payment. The real sequence is:
-- 1) trader pays the plant (outside the system, wire transfer),
-- 2) trader clicks "Confirmar pago enviado" in Orders — this sets plant_paid_at AND sends a real
--    email to the plant confirming the payment (never auto-sent, same preview-before-send modal
--    as every other document),
-- 3) only once plant_paid_at is set does a separate alert fire asking for the release number —
--    "el pago habilita a buentrade a pedir el release number."
-- release_number_alert_sent_at is the dedup column for that third step, same pattern as every
-- other *_alert_sent_at column already on this table.
-- ============================================================================

alter table shipments add column plant_paid_at timestamptz;
alter table shipments add column release_number_alert_sent_at timestamptz;

-- ============================================================================
-- End.
-- ============================================================================
