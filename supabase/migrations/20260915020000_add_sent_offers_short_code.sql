-- Real ask 2026-09-15: sending a product offer over WhatsApp today means downloading the photo to
-- the trader's device and manually dragging it into the chat — real, working, but manual, and the
-- user wants it automatic instead: a short link (like the invoice-signature one) whose WhatsApp
-- preview card shows the REAL product photo, so the trader just sends a link and WhatsApp renders
-- the card itself. Same short_code pattern as shipments.invoice_short_code (see
-- 20260915010000_add_invoice_short_code.sql) — a short, WhatsApp-message-friendly lookup key,
-- generated at send time in sent-offers-create.
--
-- photo_url is snapshotted here (not looked up live from plant_products at card-render time)
-- because sent_offers already exists specifically to snapshot what the customer was actually shown
-- at send time (see the file header comment on supabase/functions/sent-offers-create/index.ts) — a
-- later photo change on plant_products must never silently rewrite an already-sent card's image.
alter table sent_offers
  add column if not exists photo_url text,
  add column if not exists short_code text;

create unique index if not exists sent_offers_short_code_idx
  on sent_offers (short_code) where short_code is not null;
