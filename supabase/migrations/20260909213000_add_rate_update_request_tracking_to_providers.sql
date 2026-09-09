-- ============================================================================
-- add_rate_update_request_tracking_to_providers.sql
--
-- Real ask 2026-09-09: "mandar un update a los carriers" — a second, distinct action from
-- Locations Catalog's "Load Prices", which only ever pastes rates already received. This tracks
-- when a carrier was last asked for fresh US Freight rates, same shape as plant_products'
-- own last_requested_at (Ask Price), so a carrier nobody's chased in a while looks different
-- from one just asked today.
-- ============================================================================

alter table providers add column last_rate_update_requested_at timestamptz;

-- ============================================================================
-- End.
-- ============================================================================
