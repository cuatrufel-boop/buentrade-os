-- ============================================================================
-- 20260922140000_market_flash_species_and_term_learning.sql
--
-- Real ask 2026-09-22 ("no es solo por producto, hay cosas de proteina y de mercado... que no se
-- equivoque hasta que aprende"): two additions, same day as product_market_notes/
-- product_market_note_suggestions, extending "Market Flash" (renamed from "boletín" — real
-- terminology correction) beyond single-product notes:
--
-- 1. product_market_notes.product_id becomes nullable, category_id added — a note is now EITHER
--    product-scoped (product_id set) or species/category-scoped (category_id set, e.g. "Pork"
--    overall). computeCustomerProductSignal falls back to the category-level note only when no
--    product-specific one exists for that exact product — never a standalone broadcast, always
--    attached to the same real moments (quote/delivery-thank-you/cadence) already built.
--
-- 2. market_flash_term_aliases — the real "learn the language" mechanism, same proven shape as
--    plant_term_aliases (see that table's own migrations): a term gets asked about ONCE, the
--    trader's answer (product / species / market-general-no-association) is remembered forever,
--    every future Market Flash auto-resolves that exact term without asking again.
-- ============================================================================

alter table product_market_notes alter column product_id drop not null;
alter table product_market_notes add column category_id uuid references categories(id) on delete cascade;
alter table product_market_notes add constraint product_market_notes_scope_check
  check ((product_id is not null and category_id is null) or (product_id is null and category_id is not null));

create index product_market_notes_category_idx on product_market_notes(category_id, note_date desc);

create table market_flash_term_aliases (
  id uuid primary key default gen_random_uuid(),
  term text not null,
  meaning_type text not null check (meaning_type in ('product', 'species', 'market')),
  meaning_id uuid, -- product_id when 'product', category_id when 'species', null when 'market' (no association, ever)
  created_by text,
  created_at timestamptz not null default now(),
  unique (term)
);

-- ============================================================================
-- End of 20260922140000.
-- ============================================================================
