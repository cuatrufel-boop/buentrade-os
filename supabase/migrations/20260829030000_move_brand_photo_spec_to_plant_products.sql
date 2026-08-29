-- Real correction to the data model: `products` is the shared cut identity (name, category,
-- temperature, packaging) that many plants offer identically. Brand, Photo, and Spec Sheet are
-- NOT shared — the same cut sold by two different plants has two different brands/photos/specs.
-- They belong on plant_products (the per-plant link), never on products itself.
--
-- products.brand_id was added this session and never used by any real row (0 products exist) —
-- safe to drop outright rather than leave as a second dead column alongside legacy `brand`.
alter table products drop column if exists brand_id;

alter table plant_products add column if not exists brand_id uuid references brands(id);
alter table plant_products add column if not exists photo_url text;
alter table plant_products add column if not exists spec_url text;
