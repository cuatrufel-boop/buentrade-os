-- Usual Incoterm was free text on customers — a real duplicate/typo risk (FOB vs Fob vs F.O.B.)
-- that the catalog-matching rules exist to close. The base schema even references an `incoterms`
-- table that was "created in master_data_schema.sql, never wired to any screen" — this finally
-- wires it up, as a real closed list (the 11 official Incoterms 2020 codes), never a create
-- endpoint: this is a fixed international standard, not something that legitimately grows.
--
-- Re-verified against orders-compose-so's real usage (2026-08-28 comment there): the actual
-- printed INCOTERMS field is often the code PLUS a named place ("DAP Nogales, AZ"), not just the
-- bare code — so the place stays a separate free-text field alongside the closed code, instead of
-- folding the whole thing into one string that could drift.
create table if not exists incoterms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_en text not null
);

insert into incoterms (code, name_en) values
  ('EXW', 'Ex Works'),
  ('FCA', 'Free Carrier'),
  ('FAS', 'Free Alongside Ship'),
  ('FOB', 'Free On Board'),
  ('CFR', 'Cost and Freight'),
  ('CIF', 'Cost, Insurance and Freight'),
  ('CPT', 'Carriage Paid To'),
  ('CIP', 'Carriage and Insurance Paid To'),
  ('DAP', 'Delivered At Place'),
  ('DPU', 'Delivered At Place Unloaded'),
  ('DDP', 'Delivered Duty Paid')
on conflict (code) do nothing;

alter table customers add column if not exists usual_incoterm_id uuid references incoterms(id);
alter table customers add column if not exists usual_incoterm_place text;

-- No live customer data has ever populated usual_incoterm_text (confirmed empty via
-- customers-search before this migration), so there's nothing to backfill — safe to drop outright
-- rather than leave a second, now-unused way to say the same thing.
alter table customers drop column if exists usual_incoterm_text;
