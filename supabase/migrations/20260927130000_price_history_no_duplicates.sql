-- ============================================================================
-- 20260927130000_price_history_no_duplicates.sql
--
-- Found in the 2026-09-27 audit: 19 of 106 price_history rows were exact repeats (same plant, product, price, currency
-- and date) — a price re-typed or re-applied the same day was appended again each time, which inflates the history and
-- skews price trends. Keep the first of each, and make a repeat impossible: both writers (applyPlantProductMatch and
-- plant-products-update) now insert with `on conflict do nothing` against this key.
-- A price that CHANGES the same day is a different row (different price) and is still kept.
-- ============================================================================
begin;
delete from price_history p using (
  select id from (select id, row_number() over (partition by plant_id, product_id, price, price_currency_id, price_date order by created_at, id) rn from price_history) x
  where rn > 1
) d where p.id = d.id;
create unique index price_history_one_per_price_day on price_history (plant_id, product_id, price, price_currency_id, price_date) nulls not distinct;
commit;
