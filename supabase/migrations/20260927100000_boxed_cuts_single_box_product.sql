-- ============================================================================
-- 20260927100000_boxed_cuts_single_box_product.sql
--
-- Rule confirmed by the user 2026-09-27: a cut that comes in a box is ONE BuenTrade product, "…, Box". Plants sometimes
-- say VAC / Poly / Wax / IWP (what's inside the box), sometimes only "Box", sometimes nothing — it is the same product,
-- and before a bid the trader never asks. VAC vs Poly is only confirmed with the plant when closing.
-- The catalog had 27 products carrying an inner pack (Vac 17, Poly 7, Wax 2, Iwp 1) — the same cut duplicated.
--
--   MERGE  (13): an "…, Box" product already exists for the same cut + temperature → everything moves to the Box row
--                (plant prices, customers + cadence, price history, plant aliases, pending-match resolutions) and the
--                duplicate row is deleted. Same plant priced on both → the most recent price stays (price_history keeps
--                every old price anyway).
--   RENAME (14): no Box row yet → the product itself becomes "…, Box" (same id, so nothing that points to it moves).
--                Pork Cushion Frozen had two (Poly Bag + VAC): the Poly Bag row is renamed, the VAC row merges into it.
--
-- One sent offer pointed to a merged row (Pork Boneless Picnic Frozen, Poly): its product_id now points to the Box row;
-- the offer's own stored name/spec text (what was actually sent) is not touched.
-- Combo and Bulk are different containers and are not part of this.
-- ============================================================================
begin;

create temp table box_map (src uuid primary key, dst uuid not null, kind text not null) on commit drop;

with p as (
  select id, full_name_en,
         regexp_replace(full_name_en, ',\s*[^,]+$', '') as cut_temp,
         lower(trim(regexp_replace(full_name_en, '^.*,\s*', ''))) as pack
  from products where full_name_en like '%,%'
),
inner_p as (select * from p where pack in ('vac', 'poly', 'poly bag', 'iwp', 'wax')),
box_p as (select * from p where pack = 'box')
insert into box_map (src, dst, kind)
select i.id, b.id, 'merge' from inner_p i join box_p b on b.cut_temp = i.cut_temp;

-- Pork Cushion Frozen: Poly Bag becomes the Box row, VAC merges into it.
insert into box_map (src, dst, kind)
select v.id, pb.id, 'merge'
from products v, products pb
where v.full_name_en = 'Pork Cushion Frozen, VAC' and pb.full_name_en = 'Pork Cushion Frozen, Poly Bag';

-- ---------- MERGE ----------
-- Plant prices: same plant on both → keep the most recent price on the Box row.
update plant_products d set
  current_price = s.current_price, price_currency = s.price_currency, price_currency_id = s.price_currency_id,
  price_date = s.price_date, docs_included = s.docs_included, notes = s.notes, location_id = s.location_id,
  freight_included = s.freight_included, availability = s.availability, updated_at = now()
from plant_products s join box_map m on m.src = s.product_id and m.kind = 'merge'
where d.product_id = m.dst and d.plant_id = s.plant_id and s.current_price is not null
  and (d.current_price is null or (s.price_date, s.updated_at) > (d.price_date, d.updated_at));
update plant_products d set last_requested_at = greatest(d.last_requested_at, s.last_requested_at)
from plant_products s join box_map m on m.src = s.product_id and m.kind = 'merge'
where d.product_id = m.dst and d.plant_id = s.plant_id and s.last_requested_at is not null;
delete from plant_products s using box_map m, plant_products d
where m.src = s.product_id and m.kind = 'merge' and d.product_id = m.dst and d.plant_id = s.plant_id;
update plant_products s set product_id = m.dst, updated_at = now() from box_map m where m.src = s.product_id and m.kind = 'merge';

-- Customers (and their stated cadence): same customer on both → keep the Box link, fill any empty cadence from the other.
update customer_products d set
  frequency_days = coalesce(d.frequency_days, s.frequency_days),
  loads_per_cycle = coalesce(d.loads_per_cycle, s.loads_per_cycle),
  last_known_order_date = greatest(d.last_known_order_date, s.last_known_order_date)
from customer_products s join box_map m on m.src = s.product_id and m.kind = 'merge'
where d.product_id = m.dst and d.customer_id = s.customer_id;
delete from customer_products s using box_map m, customer_products d
where m.src = s.product_id and m.kind = 'merge' and d.product_id = m.dst and d.customer_id = s.customer_id;
update customer_products s set product_id = m.dst from box_map m where m.src = s.product_id and m.kind = 'merge';

-- Everything else that points to a product.
update price_history x set product_id = m.dst from box_map m where m.src = x.product_id and m.kind = 'merge';
update plant_product_aliases x set product_id = m.dst from box_map m where m.src = x.product_id and m.kind = 'merge';
update plant_pending_matches x set resolved_product_id = m.dst from box_map m where m.src = x.resolved_product_id and m.kind = 'merge';
-- Pending Matches keep their candidate list as a jsonb array of product ids (no FK): swap each merged id for its Box id.
update plant_pending_matches pm set candidate_product_ids = (
  select jsonb_agg(distinct coalesce(m.dst::text, c))
  from jsonb_array_elements_text(pm.candidate_product_ids) c
  left join box_map m on m.src::text = c and m.kind = 'merge')
where pm.candidate_product_ids is not null and jsonb_typeof(pm.candidate_product_ids) = 'array'
  and exists (select 1 from jsonb_array_elements_text(pm.candidate_product_ids) c join box_map m on m.src::text = c and m.kind = 'merge');
update market_flash_term_aliases x set meaning_id = m.dst from box_map m where m.src = x.meaning_id and m.kind = 'merge';
update load_closed_notifications x set product_id = m.dst from box_map m where m.src = x.product_id and m.kind = 'merge';
-- Offer Sheets: only one OPEN sheet per product. If the Box row already has an open sheet, the merged row's open sheet
-- folds into it (its customers and asked plants move over, keeping the earliest ask), then it is removed.
insert into offer_sheet_customers (sheet_id, customer_id, added_at)
select d.id, c.customer_id, c.added_at
from offer_sheets s join box_map m on m.src = s.product_id and m.kind = 'merge'
join offer_sheets d on d.product_id = m.dst and d.status = 'open'
join offer_sheet_customers c on c.sheet_id = s.id
where s.status = 'open'
on conflict (sheet_id, customer_id) do nothing;
insert into offer_sheet_plants (sheet_id, plant_id, asked_at, reminded_at, answered_at)
select d.id, x.plant_id, x.asked_at, x.reminded_at, x.answered_at
from offer_sheets s join box_map m on m.src = s.product_id and m.kind = 'merge'
join offer_sheets d on d.product_id = m.dst and d.status = 'open'
join offer_sheet_plants x on x.sheet_id = s.id
where s.status = 'open'
on conflict (sheet_id, plant_id) do update set
  asked_at = least(offer_sheet_plants.asked_at, excluded.asked_at),
  reminded_at = greatest(offer_sheet_plants.reminded_at, excluded.reminded_at),
  answered_at = greatest(offer_sheet_plants.answered_at, excluded.answered_at);
delete from offer_sheets s using box_map m, offer_sheets d
where m.src = s.product_id and m.kind = 'merge' and s.status = 'open' and d.product_id = m.dst and d.status = 'open';
update offer_sheets x set product_id = m.dst from box_map m where m.src = x.product_id and m.kind = 'merge';
update sent_offers x set product_id = m.dst from box_map m where m.src = x.product_id and m.kind = 'merge';
update purchase_orders x set product_id = m.dst from box_map m where m.src = x.product_id and m.kind = 'merge';
update sales_orders x set product_id = m.dst from box_map m where m.src = x.product_id and m.kind = 'merge';

delete from products x using box_map m where m.src = x.id and m.kind = 'merge';

-- ---------- RENAME ----------
-- Every remaining product with an inner pack becomes "…, Box" / "…, Caja" on the Box packaging row.
update products set
  packaging_id = (select id from packaging where lower(name_en) = 'box'),
  full_name_en = regexp_replace(full_name_en, ',\s*[^,]+$', ', Box'),
  full_name_es = regexp_replace(full_name_es, ',\s*[^,]+$', ', Caja'),
  updated_at = now()
where packaging_id in (select id from packaging where lower(name_en) in ('vac', 'poly', 'wax', 'iwp'));

commit;
