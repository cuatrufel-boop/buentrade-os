-- A bulletin can be stored before its commentary (page-2 analyst text) has been read, because the AI service was unavailable. That used to be
-- invisible and permanent. narrative_error now says so, the reader retries (narrative_retry_at limits it to once an hour), and the state shows in
-- "Mail needing attention" until the commentary is read.
alter table market_flash_bulletins
  add column narrative_error text,
  add column narrative_retry_at timestamptz;

-- Bulletins already stored with neither commentary bullets nor commentary decisions never had their commentary read (the 2026-09-19 edition).
update market_flash_bulletins b
set narrative_error = 'the commentary was not read when this bulletin was loaded (the AI service was unavailable)'
where not exists (select 1 from market_flash_bullets x where x.bulletin_id = b.id and x.kind in ('narrative_view', 'narrative_observed'))
  and not exists (select 1 from jsonb_array_elements(b.dropped) d where d->>'kind' = 'narrative');
