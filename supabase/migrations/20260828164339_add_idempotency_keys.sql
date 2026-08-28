-- ============================================================================
-- add_idempotency_keys.sql
--
-- A caller (frontend double-click, a retried network request) can now pass an
-- idempotency_key with any of the write endpoints below. The endpoint checks
-- it first and returns the existing row instead of creating a second one —
-- additive only: omitting the key keeps today's behavior exactly as-is.
--
-- Scoped to endpoints with no existing natural duplicate guard:
--   sent_offers, shipments, order_extra_costs, provider_rates (the plain
--   .create insert, not the .set upsert which already has one),
--   plant_locations, and the 5 master-data .create endpoints (customers,
--   suppliers, plants, products, providers) — added there as a fast-path
--   ahead of their existing fuzzy near-duplicate check, not a replacement
--   for it.
-- ============================================================================

alter table sent_offers add column idempotency_key text;
alter table shipments add column idempotency_key text;
alter table order_extra_costs add column idempotency_key text;
alter table provider_rates add column idempotency_key text;
alter table plant_locations add column idempotency_key text;
alter table customers add column idempotency_key text;
alter table suppliers add column idempotency_key text;
alter table plants add column idempotency_key text;
alter table products add column idempotency_key text;
alter table providers add column idempotency_key text;

create unique index sent_offers_idempotency_key_idx on sent_offers(idempotency_key) where idempotency_key is not null;
create unique index shipments_idempotency_key_idx on shipments(idempotency_key) where idempotency_key is not null;
create unique index order_extra_costs_idempotency_key_idx on order_extra_costs(idempotency_key) where idempotency_key is not null;
create unique index provider_rates_idempotency_key_idx on provider_rates(idempotency_key) where idempotency_key is not null;
create unique index plant_locations_idempotency_key_idx on plant_locations(idempotency_key) where idempotency_key is not null;
create unique index customers_idempotency_key_idx on customers(idempotency_key) where idempotency_key is not null;
create unique index suppliers_idempotency_key_idx on suppliers(idempotency_key) where idempotency_key is not null;
create unique index plants_idempotency_key_idx on plants(idempotency_key) where idempotency_key is not null;
create unique index products_idempotency_key_idx on products(idempotency_key) where idempotency_key is not null;
create unique index providers_idempotency_key_idx on providers(idempotency_key) where idempotency_key is not null;
