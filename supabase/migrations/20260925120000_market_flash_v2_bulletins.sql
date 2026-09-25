-- ============================================================================
-- 20260925120000_market_flash_v2_bulletins.sql
--
-- Market Flash v2 (2026-09-25, "el sistema lee el PDF solo y lo convierte en bullets"): the trader no
-- longer classifies bulletin lines by hand into product/protein/market notes. The bulletin is read
-- automatically (deterministic table parsers + audited literal translation of the narrative — see
-- supabase/functions/_shared/marketFlash/), every datum becomes a Spanish bullet tagged with levels
-- (product / protein / market — tags, never a choice), and this migration stores them.
--
--   market_flash_bulletins       one row per bulletin edition; file_hash is the idempotency key (re-uploading
--                                the same PDF, or the same email arriving twice, never creates a second one).
--                                `facts` keeps the verified data so the NEXT edition can be compared to it.
--   market_flash_bullets         the bullets. `product_entity` = the term exactly as the bulletin prints it;
--                                what it means in the catalog is NOT stored here but resolved at read time through
--                                market_flash_term_aliases (learned once, like plant_term_aliases), so teaching a
--                                term instantly applies to every bulletin already stored.
--   market_flash_bullet_sends    which bullet went to which customer, so nobody gets the same bullet twice.
--
-- market_flash_term_aliases gains meaning_type 'product_name' (category + clean name_en, any grade) — needed for
-- inventory lines such as "Bellies" that cover every belly grade, alongside the existing exact 'product_family'
-- (category + name_en + subcategory_en, which never crosses grade/size).
-- ============================================================================

alter table market_flash_term_aliases drop constraint if exists market_flash_term_aliases_meaning_type_check;
alter table market_flash_term_aliases add constraint market_flash_term_aliases_meaning_type_check
  check (meaning_type = any (array['product', 'species', 'product_family', 'product_name', 'market']));

create table market_flash_bulletins (
  id uuid primary key default gen_random_uuid(),
  as_of date not null,
  file_hash text not null unique,
  source text not null default 'upload' check (source in ('upload', 'email')),
  facts jsonb not null default '[]'::jsonb,
  per_source jsonb not null default '{}'::jsonb,
  dropped jsonb not null default '[]'::jsonb,
  created_by text,
  created_at timestamptz not null default now()
);
create index market_flash_bulletins_asof_idx on market_flash_bulletins(as_of desc);

create table market_flash_bullets (
  id uuid primary key default gen_random_uuid(),
  bulletin_id uuid not null references market_flash_bulletins(id) on delete cascade,
  key text not null,
  kind text not null,
  levels text[] not null,
  species text check (species in ('pork', 'beef', 'chicken', 'turkey')),
  market text not null check (market in ('US', 'MX')),
  product_entity text,
  text_es text not null,
  quote_en text,
  source_note text not null,
  page integer,
  computed boolean not null default false,
  valid_until date not null,
  created_at timestamptz not null default now(),
  unique (bulletin_id, key)
);
create index market_flash_bullets_bulletin_idx on market_flash_bullets(bulletin_id);
create index market_flash_bullets_entity_idx on market_flash_bullets(product_entity) where product_entity is not null;

create table market_flash_bullet_sends (
  id uuid primary key default gen_random_uuid(),
  bullet_id uuid not null references market_flash_bullets(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  channel text,
  sent_at timestamptz not null default now(),
  sent_by text,
  unique (bullet_id, customer_id)
);
create index market_flash_bullet_sends_customer_idx on market_flash_bullet_sends(customer_id);

grant select, insert, update, delete on market_flash_bulletins, market_flash_bullets, market_flash_bullet_sends to api_service;

-- ============================================================================
-- End of 20260925120000.
-- ============================================================================
