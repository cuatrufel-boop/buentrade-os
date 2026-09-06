-- ============================================================================
-- add_docs_ready_alert_tracking.sql
--
-- Real correction 2026-09-06: "debe haber alarmas urgentes de asegurarse de recibir docs de
-- planta despues de pickup" — pickup documents ready to forward to customs was only ever a
-- passive line in the client's "Necesita tu atención" panel, never a real push+email alert.
-- docs_ready_alert_sent_at re-fires hourly (not once-ever like the other alert columns) while any
-- pickup document is still unforwarded — a genuinely urgent, recurring nudge, not a one-shot.
-- (release_number_alert_sent_at already exists, added in the previous migration.)
-- ============================================================================

alter table shipments add column docs_ready_alert_sent_at timestamptz;

-- ============================================================================
-- End.
-- ============================================================================
