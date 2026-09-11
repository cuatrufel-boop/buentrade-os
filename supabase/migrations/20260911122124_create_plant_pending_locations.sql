-- Real ask 2026-09-11: "no quiero que se creen automaticamente ni que se dupliquen. quiero que me
-- salga un aviso... pidiendo permiso para crear" (both channels — "loads y correo deben sacar
-- confirmacion"). A price arriving with a pickup location this plant doesn't have yet on its own
-- Locations list (plant_locations) must never silently create that entry — it queues a suggestion
-- here instead, surfaced as a real Yes/No window in plants.html the next time that plant is open
-- (Load Prices' own Apply included, right after it runs). Mirrors plant_pending_matches' own shape
-- and lifecycle (resolved_at/resolved_by, never deleted) for the same reason: one, consistent
-- "detected something uncertain, a human decides" pattern across the app.
create table plant_pending_locations (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id),
  location_id uuid not null references locations(id),
  location_name text not null,
  raw_text text,
  detected_price numeric,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  approved boolean
);

-- One open (unresolved) suggestion per plant+location — both channels funnel through the same
-- shared write path (applyPlantProductMatch) and check-then-insert under this, but a unique index
-- on the still-open subset closes the race a plain app-level check can't.
create unique index plant_pending_locations_open_idx on plant_pending_locations (plant_id, location_id) where resolved_at is null;

create index plant_pending_locations_plant_idx on plant_pending_locations (plant_id) where resolved_at is null;
