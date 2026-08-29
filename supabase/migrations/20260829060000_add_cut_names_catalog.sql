-- The base cut name (Lomo, Cabeza de lomo, Costilla...) is a small, real, closed vocabulary in
-- the meat industry — the same cut name gets reused across many different temperature/packaging/
-- variation combinations. Same reasoning as variations: closed catalog, one selection fills both
-- languages, "+ Add new" only for a genuinely new cut that's never existed in the system before.
create table if not exists cut_names (
  id uuid primary key default gen_random_uuid(),
  name_es text not null,
  name_en text not null,
  created_at timestamptz not null default now()
);
