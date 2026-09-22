-- ============================================================================
-- 20260922130000_create_product_market_note_suggestions.sql
--
-- Real ask 2026-09-22 ("un trader no tiene tiempo para escribir cosas de mercado... el sistema
-- debe recibir el boletin"): replaces trader-types-from-scratch with trader-confirms-a-suggestion.
-- The bulletin gets read (today: shared with Claude directly, who inserts rows here reading the
-- real PDF, matching cut names against the real catalog — never a blind auto-match; a future
-- in-app AI pipeline could write here the same way without changing anything downstream) — one row
-- per cut the bulletin mentions that looks like it could be one of BuenTrade's own products.
-- suggested_product_id is a best guess, not a fact: the trader confirms or corrects it before
-- anything becomes a real product_market_notes row. Nothing here is ever shown to a customer —
-- only approved rows (in product_market_notes) are.
-- ============================================================================

create table product_market_note_suggestions (
  id uuid primary key default gen_random_uuid(),
  bulletin_date date not null default current_date,
  raw_cut_name text not null,
  suggested_product_id uuid references products(id) on delete set null,
  trend_pct numeric(6,2),
  note text,
  mx_benchmark_price_usd_kg numeric(10,3),
  mx_benchmark_region text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_by text,
  created_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz
);

create index product_market_note_suggestions_status_idx on product_market_note_suggestions(status, bulletin_date desc);

-- ============================================================================
-- End of 20260922130000.
-- ============================================================================
