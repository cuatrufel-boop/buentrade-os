-- The email-ingestion automation's review queue: a price line from an incoming plant email that
-- the deterministic matcher (products-match-from-plant-text) couldn't confidently resolve to one
-- catalog product. A confident match never lands here at all — it applies straight to
-- plant_products via the existing plant-products-apply-match path, same as Load Prices today.
-- Only the genuinely ambiguous lines wait here for a human to pick once; resolving one still goes
-- through that same apply-match endpoint (so the price+alias write logic is never duplicated) —
-- this table only tracks "is this line still open, and what did we end up picking."
create table plant_pending_matches (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id),
  raw_text text not null,
  detected_price numeric,
  -- Candidates the matcher narrowed it to (possibly empty — "no idea at all" is still a valid,
  -- real outcome, not an error) — product ids only, resolved to full rows by the frontend/search
  -- endpoint rather than duplicating product fields here.
  candidate_product_ids jsonb not null default '[]'::jsonb,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_product_id uuid references products(id),
  resolved_by text
);

-- The one query this whole feature actually runs: "does this plant have anything still open."
create index plant_pending_matches_open_idx on plant_pending_matches (plant_id) where resolved_at is null;

alter table plant_pending_matches enable row level security;
create policy api_service_full_access on public.plant_pending_matches for all to api_service using (true) with check (true);
