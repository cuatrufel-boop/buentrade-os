-- Not every packaging type is valid for every temperature — Combo is a Fresh-only packaging,
-- confirmed by the trader repeatedly (Combo + Frozen is never a real combination). NULL means
-- "valid for every temperature" (the default, unrestricted) so existing packaging types keep
-- working exactly as before unless explicitly restricted.
alter table packaging add column if not exists valid_temperature_ids uuid[];

update packaging set valid_temperature_ids = array['1027a7cd-f56c-4633-90e7-4c1c3ca58260']::uuid[]
where name_en = 'Combo';
