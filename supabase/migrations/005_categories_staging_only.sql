-- ============================================================================
-- 005_categories_staging_only.sql
--
-- STAGING ONLY (project geqhjykbxvxugvnpnygn). Fixes a real gap found while
-- designing the first Edge Function (products.matchFromPlantText):
--
-- Rule 15 ("cada planta tiene una especie fija, el sistema no adivina línea
-- por línea") has nothing to stand on today — the species/category filter
-- for a price-list batch is picked by hand in plants.html each time, not a
-- real fact stored on the plant. And `products.category` is free text with
-- no catalog behind it, so "Cerdo" and "cerdo" aren't structurally the same
-- value — rule 2/10 (category is an absolute match boundary) can't be
-- enforced reliably on top of that.
--
-- Same additive pattern as every migration so far: `category` (free text)
-- on products stays exactly as it is, nothing deleted — `category_id` is
-- added alongside it. `plants.category_id` is new, fixed per plant.
-- ============================================================================

create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  name_en text not null,
  created_at timestamptz not null default now()
);

alter table products add column category_id uuid references categories(id);
alter table plants add column category_id uuid references categories(id);

insert into categories (name, name_en) values
  ('Cerdo', 'Pork'),
  ('Pollo', 'Chicken'),
  ('Res', 'Beef'),
  ('Cordero', 'Lamb');

-- ============================================================================
-- End of 005.
-- ============================================================================
