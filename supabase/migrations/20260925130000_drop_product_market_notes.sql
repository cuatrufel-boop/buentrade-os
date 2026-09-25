-- ============================================================================
-- 20260925130000_drop_product_market_notes.sql
--
-- Market Flash v2 replaced the trader's manual product/protein/market notes (product_market_notes) with bullets
-- read automatically from the bulletin (market_flash_bullets, see 20260925120000). Nothing reads or writes this
-- table any more — customer-product-signal, price-history-search and every send path now use the bullets — and it
-- was verified empty (0 rows) before dropping. market_flash_term_aliases stays: it is the "learn once" memory
-- behind Pending Matches.
-- ============================================================================
drop table if exists product_market_notes;
