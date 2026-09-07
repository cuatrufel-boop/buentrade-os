-- ============================================================================
-- add_invoice_signed_at_to_shipments.sql
--
-- Real bug found live 2026-09-07: orders-invoice-signature's "redeem" action used
-- shipments.status === 'delivered' as its "already signed, don't re-process" check. That was fine
-- back when the trader's "Delivered" click and the customer's signature were the same event — but
-- the user clarified they are NOT: "Delivered" (Carga entregada con Éxito) is the trader
-- confirming the load physically arrived at the border, a real logistics fact, independent of
-- whether/when the customer gets around to signing the invoice for their own records. Once
-- "Delivered" can be true before any signature exists, reusing that same flag meant the
-- customer's real, first-ever signature attempt would incorrectly be told "ya fue firmada."
--
-- invoice_signed_at is its own fact: when the customer actually signed, independent of shipment
-- status. The signed PDF itself (the actual proof) is uploaded and stored the same way the
-- unsigned one was — this column just marks that the signing happened and dedupes the redeem.
-- ============================================================================

alter table shipments add column invoice_signed_at timestamptz;

-- ============================================================================
-- End.
-- ============================================================================
