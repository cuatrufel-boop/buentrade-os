-- Segunda pasada de limpieza en Suppliers

-- 1) Eliminar basura/placeholder
delete from suppliers where name = 'Company INT';

-- 2) Mover MoLo Solutions a Freight Carriers (es un freight broker, no una empacadora)
delete from suppliers where name = 'MoLo Solutions';
insert into freight_carriers (name, country, city, contact_name, email, phone)
values ('MoLo Solutions', 'United States', 'IL', 'Kevin Berardini', 'kevin.berardini@shipmolo.com', '1 8475088610');
