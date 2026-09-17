-- ============================================================================
-- 20260916192000_add_customer_product_last_known_order.sql
--
-- Real gap found wiring the "necesidad" signal: sales_orders only gets a row once an offer is won
-- through the live system (sent-offers-mark-won) — the 7 cliente-producto cadences just backfilled
-- from the historical Excel have no such row, so the cadence signal would have no "last order"
-- date to anchor against. last_known_order_date is that anchor when there's no real sales_orders
-- row yet: set once at import from real historical data, or by the trader by hand — never
-- overwritten automatically once a real order exists (the signal always prefers the real
-- sales_orders date when both exist, see computeCustomerProductSignal).
-- ============================================================================

alter table customer_products add column last_known_order_date date;

-- ============================================================================
-- End of 20260916192000.
-- ============================================================================
