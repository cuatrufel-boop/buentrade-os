-- ============================================================================
-- 20260922150000_drop_unused_market_flash_suggestions_table.sql
--
-- Real correction 2026-09-22 ("busca plants y construyelo igual — upload popup después cierro y
-- salen bullets bien hechas"): rebuilt Market Flash Admin to match plants.html's own Load Prices
-- mechanic exactly — nothing written to the database until one final "Apply All" batch commit
-- (preview_market_flash_lines is read-only, teach_term is the one write per row). The persistent
-- product_market_note_suggestions staging table from the earlier design is no longer written to or
-- read from anywhere — dropped rather than left as dead schema. Never held real data beyond this
-- session's own test rows, all already cleaned up before this migration.
-- ============================================================================

drop table if exists product_market_note_suggestions;

-- ============================================================================
-- End of 20260922150000.
-- ============================================================================
