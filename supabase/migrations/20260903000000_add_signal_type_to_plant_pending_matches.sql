-- plant_pending_matches so far only ever meant "a price line the matcher couldn't confidently
-- resolve." Real gap, explicit ask: a plant's email reply can also say it does NOT produce a
-- product at all (a permanent, structural fact — different from "not available right now," which
-- is temporary and needs no action here) — that signal has no price to detect, but still needs the
-- exact same "match it to a real catalog product, let a human confirm" queue, never auto-applied
-- (see signal_type below for why declined always waits for a human, unlike a confident price).
alter table plant_pending_matches add column signal_type text not null default 'price';
alter table plant_pending_matches add constraint plant_pending_matches_signal_type_check
  check (signal_type in ('price', 'declined'));

-- Explicit, permanent asymmetry: a confidently-matched PRICE can auto-apply (a wrong price is
-- self-correcting — the next real email overwrites it). A confidently-matched DECLINED signal
-- never auto-applies — plant_products.declined_at permanently stops that plant from ever being
-- asked again for that product (see 20260831000000_add_declined_at_to_plant_products.sql), and a
-- false positive there silently loses a real business relationship with no natural correction.
-- Every declined signal, however confident the match, becomes a plant_pending_matches row with
-- signal_type = 'declined' for a human to confirm — enforced in application code
-- (plant-price-emails-poll), documented here so the reason travels with the schema.
comment on column plant_pending_matches.signal_type is
  'price = a detected price line (may auto-apply on a confident match); declined = a "does not produce this" statement (never auto-applies — always waits here for a human to confirm, regardless of match confidence, since a false positive permanently blocks that plant for that product).';
