-- Brand was free text on products — the exact "typo creates a duplicate" risk the catalog-matching
-- rules exist to close (see feedback_fixed_catalog_terms_only). No existing brand data to migrate
-- (products.brand is empty across the board right now), so this is a clean cutover.
create table if not exists brands (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table products add column if not exists brand_id uuid references brands(id);
