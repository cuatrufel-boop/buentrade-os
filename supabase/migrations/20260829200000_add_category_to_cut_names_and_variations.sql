-- cut_names and variations were built as single global catalogs, back when every product in the
-- system was Pork. Real gap surfaced live once Chicken products started going in (2026-08-29):
-- the Cut Name and Variation dropdowns showed every category's entries mixed together — a trader
-- entering a Chicken product would see Pork cut names in the same list. Same "category never
-- crosses" boundary that already governs products/plants (see [[feedback_catalog_matching_is_the_core_system]]
-- rule 1) now applies to these two catalogs too. category_id is nullable at the DB level, same
-- convention as products.category_id/plants.category_id (005_categories_staging_only.sql) —
-- requiredness on create is enforced at the API layer, not a DB constraint.

alter table cut_names add column if not exists category_id uuid references categories(id);
alter table variations add column if not exists category_id uuid references categories(id);

-- Backfill from real usage: every cut_names row maps 1:1 to the category of the product(s) that
-- already use that exact name_en (verified live — zero ambiguous, zero orphaned, all 37 existing
-- rows resolve cleanly: 34 to Pork, 3 to Chicken).
update cut_names cn
set category_id = p.category_id
from (select distinct on (name_en) name_en, category_id from products where name_en is not null order by name_en, created_at) p
where p.name_en = cn.name_en and cn.category_id is null;

-- Variations backfill from products.subcategory_en, which joins one or more variation names with
-- ", " (see products-create's Variation panel) — split it back out to match individual entries.
update variations v
set category_id = p.category_id
from (
  select distinct trim(part) as variation_name_en, category_id
  from products, unnest(string_to_array(subcategory_en, ',')) as part
  where subcategory_en is not null
) p
where p.variation_name_en = v.name_en and v.category_id is null;

-- Anything still null here (Skin-On, 5%, 15% as of this writing) isn't used by any product yet —
-- left unresolved on purpose rather than guessed at; confirmed with the trader, category assigned
-- by hand once known, never inferred.
