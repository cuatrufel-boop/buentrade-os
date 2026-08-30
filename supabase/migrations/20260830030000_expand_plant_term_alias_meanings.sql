-- Real gap confirmed live (2026-08-30, against an actual Tyson price list): plant_term_aliases
-- only ever let a trader teach the system what a word means for temperature or packaging ("FZ" =
-- Frozen, "COV" = VAC). But a real plant's shorthand routinely abbreviates the CUT NAME itself
-- ("XF Trim" = Cutting Fat) and the VARIATION ("Bnls" = Boneless) too — no algorithm can guess
-- these from the word alone (they're genuinely arbitrary per plant), but once a trader confirms
-- one, it should never have to be asked again, same as temperature/packaging already work.
-- meaning_id stays untyped (no FK) by design — it already had to point at either temperature.id
-- or packaging.id depending on meaning_type, so it's application-typed, not DB-typed; variation.id
-- and cut_names.id just join the same pattern.
alter table plant_term_aliases drop constraint plant_term_aliases_meaning_type_check;
alter table plant_term_aliases add constraint plant_term_aliases_meaning_type_check
  check (meaning_type in ('temperature', 'packaging', 'variation', 'cut_name'));
