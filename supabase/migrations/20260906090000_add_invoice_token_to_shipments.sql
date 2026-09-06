-- ============================================================================
-- add_invoice_token_to_shipments.sql
--
-- Real correction 2026-09-06: "es en ese mismo momento que debe enviar para firmar... el share
-- invoice debe ir acompanado por una pantalla de firma que uno puede follow up en el mismo chat" —
-- the delivery signature stops being an in-person pad the trader hands the customer (BuenTrade
-- never rides the truck) and becomes a remote link sent alongside the Invoice itself, by email AND
-- WhatsApp, so the trader can follow up for a signature in the same WhatsApp thread. invoice_token
-- is the unguessable value that link carries — sign-invoice.html (a new, public, no-login page)
-- verifies it before letting anyone mark this order delivered.
-- ============================================================================

alter table shipments add column invoice_token text;

-- ============================================================================
-- End.
-- ============================================================================
