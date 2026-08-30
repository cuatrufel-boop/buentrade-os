-- Real correction 2026-08-30, confirmed against a real Seaboard sheet: a block-format list gives
-- BOTH an FOB price and a "Delivered Laredo" price per line — the parser already picks the
-- Delivered figure as current_price (confirmed prior business rule: it already includes the
-- trucking BuenTrade would otherwise add itself). Without this column, nothing downstream in
-- quotes.html knew that fact, so the no-known-city freight fallback (rqAverageUsFreightRate) could
-- silently tack a SECOND freight cost onto a price that already had one baked in — a real
-- double-charge, not a display bug.
alter table plant_products add column freight_included boolean not null default false;
