-- Closes the other half of the "todo tiene que estar conectado" gap (2026-08-30): the locations
-- catalog already backs every carrier's US Freight rate (see 20260830040000), but a plant's own
-- pickup location (plant_locations.location_name) was still a free-text string with no link to
-- it — so "Denison, IA" on a plant and "Denison IA" on a carrier rate had no guaranteed connection
-- beyond looking similar. Same fix, same shape: a nullable FK, backfilled from real data.
alter table plant_locations add column location_id uuid references locations(id);

-- All 7 real plant_locations rows on file today already parse cleanly as "City, ST" / "City ST"
-- (confirmed via plant-locations-search before writing this) and already exist in the locations
-- catalog (they're exactly where its own seed came from) — every one backfills with zero
-- unmatched, same as the provider_rates backfill.
update plant_locations pl
set location_id = l.id
from locations l
where lower(trim(regexp_replace(pl.location_name, '[,\s]+([A-Za-z]{2})$', ''))) = lower(l.city)
  and upper(right(trim(pl.location_name), 2)) = l.state;
