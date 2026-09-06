-- ============================================================================
-- add_so_and_invoice_doc_tracking.sql
--
-- Real gap found live 2026-09-06 while building the Orders "Documents" panel ("tengo que tener un
-- sitio fisico donde se guarden los docs de esa venta"): shareSO (offers.html) never called
-- markDocSent, so there was no so_sent_at column and no way to know if/when the Sales Order was
-- actually emailed to the customer. Separately, the signed Invoice (generated at delivery,
-- buildInvoiceDoc) had no tracking at all — its URL only ever lived as a free-text note inside
-- shipment_events, never a queryable column. Additive only, same pattern as every prior migration.
-- ============================================================================

alter table shipments add column so_sent_at timestamptz;
alter table shipments add column invoice_sent_at timestamptz;

-- ============================================================================
-- End.
-- ============================================================================
