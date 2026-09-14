-- ============================================================================
-- remove_unloading_stage.sql
--
-- Real ask 2026-09-14: "solo necesitamos saber que se entrego ese paso de que llego es
-- inecesario" — Unloading (the intermediate "arrived at the US border" checkpoint) is removed as
-- a tracked stage. Picked Up now goes straight to Delivered. Code changes (shipments-update-status,
-- shipment-alerts-poll, orders.html) stop ever writing status='unloading' going forward; this
-- migration only moves the shipments that were already sitting in that state back to 'picked_up'
-- (the correct collapsed state — they're in transit, not yet delivered) so no live order is stuck
-- on a status the app no longer knows how to advance past.
--
-- Deliberately NOT tightening the shipments/shipment_events CHECK constraints — 'unloading'
-- stays a legal historical value (shipment_events already has real rows logging it, a genuine
-- audit trail that must not be invalidated), it just never gets written again by any code path.
-- ============================================================================

update shipments set status = 'picked_up' where status = 'unloading';

-- ============================================================================
-- End.
-- ============================================================================
