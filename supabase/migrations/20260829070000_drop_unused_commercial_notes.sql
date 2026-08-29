-- commercial_notes: same story as presentation/origin/unit_of_measure/standard_weight — confirmed
-- via full repo search to be read by nothing downstream. Confirmed empty table, zero data loss.
alter table products drop column if exists commercial_notes;
