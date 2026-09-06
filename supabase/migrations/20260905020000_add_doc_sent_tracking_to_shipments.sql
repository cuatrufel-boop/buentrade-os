-- ============================================================================
-- add_doc_sent_tracking_to_shipments.sql
--
-- Real gap explained by the user 2026-09-05: a won order's PO (plant), Freight Confirmation
-- (carrier), and customs paperwork (border) all have to actually go out BEFORE the confirmed
-- pickup date, or the truck/pickup gets missed — "nadie lo deje pasar especialmente el carrier."
-- Nothing anywhere records whether any of those three were ever sent (sharePO/shareFO/shareCustoms
-- in offers.html are pure fire-and-forget emails, no DB write) — so there was no way to build a
-- real "pickup is in 1 day and the carrier still doesn't have the FO" warning. Additive only, same
-- pattern as every migration so far.
-- ============================================================================

alter table shipments add column po_sent_at timestamptz;
alter table shipments add column fo_sent_at timestamptz;
alter table shipments add column customs_sent_at timestamptz;

-- ============================================================================
-- End.
-- ============================================================================
