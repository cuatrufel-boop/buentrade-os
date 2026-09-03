-- Real correction: BI/BNLS/LGT/MED/SPARES/CBO (and any future abbreviation of this kind) are
-- generic meat-industry shorthand any plant could use — they were first taught scoped to
-- Wholestone's plant_id, but the user explicitly corrected that: BuenTrade must match these to the
-- same single catalog full name no matter which plant writes them. A NULL plant_id here means "this
-- term alias applies to every plant" — matchProductFromPlantText reads plant-specific aliases and
-- global ones together, plant-specific still taking precedence when both exist for the same term.
alter table plant_term_aliases alter column plant_id drop not null;
