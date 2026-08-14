-- BUENTRADE Trading OS — link each customer to the customs agency they actually cross with
--
-- Every customer clears their loads through their own customs broker at the border/destination —
-- BUENTRADE can't force them to use whichever agency BUENTRADE itself has on file. This column
-- lets Quotes pull Trámite Aduanal / Bodega Americana rates for the customer's own agency
-- instead of just grabbing the first customs_broker rate on file.
--
-- Nullable, additive: customers without an agency set yet just fall back to the old
-- "first customs rate on file" behavior in Quotes.

alter table customers
  add column if not exists customs_agency_provider_id uuid references providers(id) on delete set null;
