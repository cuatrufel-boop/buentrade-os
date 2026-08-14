-- BUENTRADE Trading OS — link US Freight rates to a real plant record
--
-- Nullable, additive column: rows without a confident plant match (e.g.
-- a city with no matching plant in the system) simply stay null and are
-- still identifiable by origin/destination text, same as before.

alter table provider_rates
  add column if not exists plant_id uuid references plants(id) on delete set null;
