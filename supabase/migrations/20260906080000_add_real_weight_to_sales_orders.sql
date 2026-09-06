-- ============================================================================
-- add_real_weight_to_sales_orders.sql
--
-- Real ask 2026-09-06: "en el momento de crear la factura con numeros reales me saca una tabla y
-- debe sacarme el QT y volver a grabarlo... para poder sacar el invoice" — the Invoice's real
-- weight (from the customs pedimento) used to be collected via a plain prompt() box in Orders.
-- It now lives here instead, entered in the same Real Costs panel (trading-tool.html) as the real
-- freight/extra costs — same pattern as freight_orders.actual_rate vs quoted_rate: weight (the
-- quote) is never touched, real_weight (the pedimento) is the adjusted number the Invoice uses.
-- ============================================================================

alter table sales_orders add column real_weight numeric;

-- ============================================================================
-- End.
-- ============================================================================
