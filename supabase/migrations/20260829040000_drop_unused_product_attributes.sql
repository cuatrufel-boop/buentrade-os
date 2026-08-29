-- presentation, origin, unit_of_measure, standard_weight: confirmed via full repo search to be
-- read by nothing — not the Trading Tool (which has its own independent manual per-line weight
-- entry for the 40,000lb truck total), not PO/SO/FO composition, nothing. presentation duplicated
-- what Packaging already said; origin varies per plant (same cut, different plant, different
-- country) so it never belonged on the shared row to begin with. Confirmed empty table, zero data
-- loss.
alter table products drop column if exists presentation;
alter table products drop column if exists origin;
alter table products drop column if exists unit_of_measure;
alter table products drop column if exists standard_weight;
