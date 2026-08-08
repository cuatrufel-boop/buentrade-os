-- Lomo Sin Cordon (fresco, combo) / Loin (Premium Iowa Pork)

insert into products (category, name, name_en, subcategory, subcategory_en, temperature_id, packaging_id, brand)
values ('Cerdo', 'Lomo', 'Loin', 'Sin Hueso, Sin Cordón', 'Boneless, Strap Off', (select id from temperature where name = 'Fresco'), (select id from packaging where name = 'Combo'), 'Premium Iowa Pork');

insert into plant_products (plant_id, product_id)
select p.id, pr.id
from plants p, products pr
where p.name ilike '%premium iowa pork%'
and pr.name = 'Lomo'
and pr.brand = 'Premium Iowa Pork'
and pr.subcategory = 'Sin Hueso, Sin Cordón'
on conflict do nothing;
