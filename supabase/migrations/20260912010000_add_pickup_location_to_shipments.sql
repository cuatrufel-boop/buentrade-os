-- Real ask 2026-09-12: "piensa en todo el proceso... la que lo trae desde el pricing ese es el
-- location que debe traer a través de todo el proceso hasta cerrar. las que no debe poderse
-- escoger manualmente hasta decidir al final." When a price came with a real ship-from city
-- (plant_products.location_id), that city already carries through automatically today via
-- sent_offers.us_freight_rate_id -> provider_rates.location_id -> plant_locations (same plant_id)
-- — no new column needed for that case, it's a live join, not a stored fact, so it can never drift.
-- This column is only for the OTHER case: a price with no known city, where the pickup location is
-- a real trader decision made at Confirm Load (the "decidir al final" moment) — never earlier, and
-- never automatic.
alter table shipments add column pickup_location_id uuid references plant_locations(id);
