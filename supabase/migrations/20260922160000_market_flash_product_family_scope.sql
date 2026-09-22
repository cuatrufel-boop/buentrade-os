-- ============================================================================
-- 20260922160000_market_flash_product_family_scope.sql
--
-- Real addition 2026-09-22 ("si no especifica que llegue a todos si especifica que lo asocie con
-- el correcto y solo llegue a los que compran ese especifico"): the bulletin often names a cut
-- generically ("Picnic, Picnic Cushion Meat Combo") with no packaging or temperature — BuenTrade's
-- catalog splits that same cut into several real SKUs (Bone-In/Boneless x Fresh/Frozen x
-- Combo/Box/VAC/Poly — 6 real Picnic rows found live). Forcing a trader to pick ONE exact SKU for
-- a generic bulletin line mis-attributes the note to only that one variant's customers, and hides
-- it from every other Picnic buyer. products.name_en is already the clean, shared base name across
-- those variants (the same field the customer-facing-naming convention already keeps free of
-- packaging/temperature) — reused here as the family key rather than inventing a new grouping
-- concept. category_id is required alongside it so the family lookup never crosses categories
-- (same "category never crosses" discipline as every other catalog-matching rule).
-- ============================================================================

alter table product_market_notes add column if not exists product_name_en text;

alter table product_market_notes drop constraint if exists product_market_notes_scope_check;
alter table product_market_notes add constraint product_market_notes_scope_check check (
  (product_id is not null and category_id is null and product_name_en is null)
  or (product_id is null and category_id is not null and product_name_en is null)
  or (product_id is null and category_id is not null and product_name_en is not null)
);

alter table market_flash_term_aliases add column if not exists meaning_text text;

alter table market_flash_term_aliases drop constraint if exists market_flash_term_aliases_meaning_type_check;
alter table market_flash_term_aliases add constraint market_flash_term_aliases_meaning_type_check
  check (meaning_type = any (array['product', 'species', 'product_family', 'market']));

-- ============================================================================
-- End of 20260922160000.
-- ============================================================================
