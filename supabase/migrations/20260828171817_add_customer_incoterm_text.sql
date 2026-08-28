-- ============================================================================
-- add_customer_incoterm_text.sql
--
-- customers.html already had a "Usual Incoterm" input on the form (id=
-- usual_incoterm_text) — the column just never existed, so anything typed
-- there was silently discarded on save. Confirmed missing while porting
-- orders-compose-so, whose INCOTERMS field is this exact stored per-customer
-- text (e.g. "FOB", "CIF", "DAP planta"), not something computed.
-- ============================================================================

alter table customers add column usual_incoterm_text text;
