-- Producto 1: Cabeza de Cerdo / Pork Heads (Lynch BBQ)

-- Marca directo en el producto
update products
set temperature_id = (select id from temperature where name = 'Frozen'),
    packaging_id = (select id from packaging where name = 'Caja'),
    name_en = 'Pork Heads',
    brand = 'Lynch BBQ'
where name = 'Cabeza de Cerdo';

delete from products where name = 'Cabeza' and category = 'Cerdo';

-- Crear la Planta "Lynch BBQ" conectada a su Supplier ya existente
-- (sin ON CONFLICT porque plants no tiene una restricción única todavía;
-- se evita el duplicado revisando que no exista ya una planta de ese supplier)
insert into plants (supplier_id, name)
select s.id, s.name from suppliers s
where s.name ilike '%lynch%'
and not exists (select 1 from plants p where p.supplier_id = s.id);

-- Vincular el producto a esa planta (precio/disponibilidad quedan vacíos por ahora)
insert into plant_products (plant_id, product_id)
select p.id, pr.id
from plants p, products pr
where p.name ilike '%lynch%' and pr.name = 'Cabeza de Cerdo'
on conflict do nothing;
