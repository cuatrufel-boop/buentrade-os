-- A plant's pick-up facility has its own street address, separate from the plant's offices (user 2026-10-03: "una cosa es donde son las
-- oficinas y otra es donde se recoge la carga"). Tyson's four facility addresses were typed inside the notes ("... Address: 1009 Richland Dr,
-- Storm Lake, IA 50588"): they move to the new field and the sentence leaves the notes, so the address lives in one place.
alter table plant_locations add column if not exists address text;

update plant_locations
set address = nullif(btrim(substring(notes from '(?i)address:\s*(.+?)\s*$'), ' .,;'), ''),
    notes   = nullif(btrim(regexp_replace(notes, '(?i)\s*address:\s*.+?\s*$', ''), ' '), '')
where address is null and notes ~* 'address:\s*\S';
