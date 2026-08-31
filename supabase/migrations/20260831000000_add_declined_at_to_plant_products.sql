-- Real gap confirmed 2026-08-31: a plant can be asked for a price on a product it simply doesn't
-- make — with no way to record that, the trader (or anyone else touching this plant later) has no
-- way to know it was already asked and declined, so the same plant gets asked the same question
-- again later. Plants find this genuinely annoying ("les molesta mucho... pedir varias veces un
-- producto que no producen cuando ya nos dijeron que no"). One nullable timestamp — null means
-- normal (missing/priced/stale, same as before), set means "this plant told us they don't make
-- this," permanent and never re-asked. Kept on plant_products itself (not a separate table) since
-- it's one more fact about one specific plant+product link, exactly like last_requested_at already
-- is.
alter table plant_products add column if not exists declined_at timestamptz;
