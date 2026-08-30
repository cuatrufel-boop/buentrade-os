-- The last link in the catalog chain (see [[project_locations_catalog_next_phase]] §2): a specific
-- price row now knows which real city it ships from, so the Trading Tool can look up every
-- carrier's rate for that exact city and pick the cheapest automatically, instead of a manual pick
-- or an always-broken plant-scoped filter (confirmed live 2026-08-30: provider_rates.plant_id is
-- 0/34 populated on every real US Freight rate on file, so the old "rates for this plant" query in
-- quotes.html always returned empty).
alter table plant_products add column location_id uuid references locations(id);
