-- Corrige la mezcla de idiomas: Temperature estaba en inglés, Packaging en
-- español. Ahora ambos quedan con `name` en español (cliente) y `name_en`
-- en inglés (planta), igual que ya hicimos con Products.

alter table temperature add column name_en text;
update temperature set name_en = 'Fresh', name = 'Fresco' where name = 'Fresh';
update temperature set name_en = 'Frozen', name = 'Congelado' where name = 'Frozen';

alter table packaging add column name_en text;
update packaging set name_en = 'Combo' where name = 'Combo';
update packaging set name_en = 'Box' where name = 'Caja';
update packaging set name_en = 'Vacuum Pack' where name = 'Vacío';
update packaging set name_en = 'Bulk' where name = 'Granel';
