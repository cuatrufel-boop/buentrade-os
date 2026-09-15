-- Real ask 2026-09-15: the product-card short link (see 20260915020000_add_sent_offers_short_code)
-- should also be able to show the real spec sheet PDF already uploaded on plant_products.spec_url
-- when a product has no real photo yet (which is every product today — 0 of 212 plant_products
-- rows have a photo_url, confirmed live; only 4 have a real spec_url). Same snapshot-at-send-time
-- reasoning as photo_url.
alter table sent_offers
  add column if not exists spec_url text;
