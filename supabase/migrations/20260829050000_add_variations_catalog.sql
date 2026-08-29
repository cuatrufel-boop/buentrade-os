-- Variation (con hueso, sin hueso, con piel, etc.) repeats across many different base product
-- names — exactly the kind of value that should be a closed catalog, not free text typed twice
-- (once per language) on every single product. products.subcategory/subcategory_en stay as the
-- actual stored text (nothing downstream changes), but the UI now fills both from one dropdown
-- selection here, same pattern as Category/Temperature/Packaging.
create table if not exists variations (
  id uuid primary key default gen_random_uuid(),
  name_es text not null,
  name_en text not null,
  created_at timestamptz not null default now()
);
