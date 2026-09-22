-- ============================================================================
-- 20260922170000_market_flash_family_subcategory_boundary.sql
--
-- Real correction 2026-09-22 ("mucho cuidado con la api y con los sensores no se puede equivocar"):
-- the product-family scope added minutes earlier (20260922160000) grouped purely on products.
-- name_en, which turned out to also collapse real, non-interchangeable grades — confirmed live
-- against the catalog: "Trim" groups 42% and 72% trim (different fat content, different real
-- price), "Spareribs" groups Light/Medium/#2 (different real grades), "Bellies" groups 9/11,
-- 13/15, 15/17, 6/9 and #2 (different real weight ranges). Bundling those under one family note
-- would send a trend that applies to one grade to every customer of every other grade — exactly
-- the wrong-customer risk just raised. products.subcategory_en already carries exactly this
-- distinction (grade/size/bone-in-boneless) — reusing it as a second, mandatory family key
-- alongside name_en, so a family only ever collapses packaging + temperature, never anything else.
-- ============================================================================

alter table product_market_notes add column if not exists product_subcategory_en text;
alter table market_flash_term_aliases add column if not exists meaning_subtext text;

-- ============================================================================
-- End of 20260922170000.
-- ============================================================================
