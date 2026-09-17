-- ============================================================================
-- 20260916191000_add_customer_product_cadence.sql
--
-- Real ask 2026-09-16: capture what the trader is told on the phone ("compro 3 cargas por semana
-- de este producto") right on the existing Customers <-> Products link — no new table, no new
-- screen, just two fields on customer_products, shown in the same "Products a customer buys"
-- section customers.html already has. next_expected_date is deliberately NOT a stored column —
-- it's computed live (last real order + frequency_days) wherever it's needed, so it can never go
-- stale the way a persisted date would.
-- ============================================================================

alter table customer_products add column frequency_days integer;
alter table customer_products add column loads_per_cycle integer;

-- ============================================================================
-- End of 20260916191000.
-- ============================================================================
