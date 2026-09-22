-- ============================================================================
-- 20260922120000_add_mx_benchmark_to_market_notes.sql
--
-- Real ask 2026-09-22 ("comparación con precio de mercado mexicano local, SOLO cuando favorece a
-- BUENTRADE"): the bulletin's own "Mexican Pork Prices" page (SNIIM, Distrito Federal / Nuevo León,
-- USD/kg — a real page this session read out of the user's own uploaded bulletin PDF). Stored on
-- the same product_market_notes row as the trend/note — one trader input pass per product per
-- bulletin, not a second table. The favorable/unfavorable comparison itself is never computed or
-- stored here — it needs the REAL price being quoted at that moment, which this table has no
-- knowledge of; that comparison happens client-side, at send time, against the actual plant price,
-- and the line is only ever shown when BuenTrade's price genuinely wins.
-- ============================================================================

alter table product_market_notes add column mx_benchmark_price_usd_kg numeric(10,3);
alter table product_market_notes add column mx_benchmark_region text;

-- ============================================================================
-- End of 20260922120000.
-- ============================================================================
