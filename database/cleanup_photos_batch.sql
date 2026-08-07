-- Producto 2: Buche / (Seaboard)

delete from products where name = 'Buche';

insert into products (category, name, name_en, temperature_id, packaging_id, brand)
values ('Cerdo', 'Buche', 'Hog Maw', (select id from temperature where name = 'Congelado'), (select id from packaging where name = 'Caja'), 'Seaboard');

insert into plants (supplier_id, name)
select s.id, s.name from suppliers s
where s.name ilike '%seaboard%'
and not exists (select 1 from plants p where p.supplier_id = s.id);

insert into plant_products (plant_id, product_id)
select p.id, pr.id
from plants p, products pr
where p.name ilike '%seaboard%' and pr.name = 'Buche'
on conflict do nothing;
