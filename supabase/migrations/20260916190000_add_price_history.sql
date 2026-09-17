-- ============================================================================
-- 20260916190000_add_price_history.sql
--
-- Real ask 2026-09-16: "el precio del producto de la misma marca" (this plant's own price over
-- time) vs "el precio del producto en el mercado o sea todas las marcas" (every plant's price for
-- the same product_id) both need a real history, not just plant_products.current_price which gets
-- overwritten on every new price list. One log table serves both views: filter by plant_id for the
-- brand/plant trend, group by product_id only for the market-wide trend. Additive only, same
-- pattern as every migration so far — nothing reads this yet, it just starts accumulating today so
-- a trend feature has real data whenever it's built.
-- ============================================================================

create table price_history (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  price numeric(12,4) not null,
  price_currency_id uuid references currencies(id),
  price_date date not null,
  created_at timestamptz not null default now()
);
create index price_history_product_idx on price_history(product_id, price_date);
create index price_history_plant_product_idx on price_history(plant_id, product_id, price_date);

-- ============================================================================
-- End of 20260916190000.
-- ============================================================================
