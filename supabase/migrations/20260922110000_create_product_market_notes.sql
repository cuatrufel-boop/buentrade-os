-- ============================================================================
-- 20260922110000_create_product_market_notes.sql
--
-- Real ask 2026-09-22 ("el boletín de la industria... úsalo por producto específico"): captures
-- what the trader reads off the bi-weekly industry bulletin (Andes Global Trading/USDA-sourced, a
-- real PDF the user shared and this session analyzed in detail) for ONE catalog product at a time —
-- never auto-matched from the bulletin's own text, the trader picks the product themselves via the
-- same product search already used everywhere else in the app. One row per (product, date) kept —
-- history is never deleted — but only the most recent row within a freshness window is ever
-- surfaced (see computeProductPriceSignal's sibling read in price-history-search), matching the
-- bulletin's own bi-weekly cadence so a stale note never keeps showing after the next one arrives.
-- ============================================================================

create table product_market_notes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  note_date date not null default current_date,
  trend_pct numeric(6,2),
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

create index product_market_notes_product_date_idx on product_market_notes(product_id, note_date desc);

-- ============================================================================
-- End of 20260922110000.
-- ============================================================================
