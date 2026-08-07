-- BUENTRADE Trading OS — limpieza de clientes + productos por cliente
-- Fuente: Desktop/Buentrade/Pipeline/Client - Product.xlsx (hojas 2024 y 2025)

-- 1) Eliminar los 3 clientes que no aplican
delete from customers where trade_name in (
  'Com de Alimentos Masivos s.a. de c.v.',
  'Pradera del Grijalva SA de CV',
  'Productos Chata SA de CV'
);

-- 2) Tabla de relación Customers <-> Products
create table customer_products (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (customer_id, product_id)
);
alter table customer_products enable row level security;
create policy "authenticated_full_access_customer_products"
on customer_products for all to authenticated using (true) with check (true);
grant select, insert, update, delete on customer_products to authenticated;

-- 3) Catálogos: Packaging y Temperature
insert into packaging (name) values ('Combo'), ('Caja') on conflict (name) do nothing;
insert into temperature (name) values ('Fresh'), ('Frozen') on conflict (name) do nothing;

-- 4) Productos (categoría genérica 'Cerdo y Pollo' — se refina en el módulo Products)
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Heart', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Cachete', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Inner', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Buche', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'B In loin', (select id from packaging where name = 'Combo'), (select id from temperature where name = 'Fresh'));
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Papada', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Grasa', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Tocino', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Lengua', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'trompa', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Mascara', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Bless Picnic', (select id from packaging where name = 'Combo'), (select id from temperature where name = 'Fresh'));
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Cuero', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Recortes', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Corbata', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Lomo sin hueso sin cordon fresco', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Pierna sin hueso', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Carcass', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Cabeza', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Manita', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Patita', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Recorte de Pechuga', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Recorte de Tender', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'PYM', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Alita Misscut', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Pechuga', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'WOG', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Pierna Bate', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'ala entera', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Empanizaldos', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Molida de pechuga', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Mollejas', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Lomo con hueso', (select id from packaging where name = 'Combo'), (select id from temperature where name = 'Fresh'));
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Lomo sin hueso', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Cabeza de Lomo sin hueso', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Papada', (select id from packaging where name = 'Caja'), (select id from temperature where name = 'Frozen'));
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Papada', (select id from packaging where name = 'Combo'), (select id from temperature where name = 'Fresh'));
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Corazon', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Oreja', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Punta de Chuleta', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Picnic Sin Hueso', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Tocino #2', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Sirloin', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Cushion', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'outter', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Alitas', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'P&M', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Papas', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Pasta De Pollo', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Empanizados', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Menudo', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Pulpa Bola', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Pata de Res', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Diezmillo', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Labio', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Clod', null, null);
insert into products (category, name, packaging_id, temperature_id) values ('Cerdo y Pollo', 'Gooseneck', null, null);

-- 5) Vincular cada cliente con los productos que compra
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Abastecedora de carnes Los Corrales' and p.name = 'Heart' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Heart' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Dist. de Carnes Int del Norte DYCINSA' and p.name = 'Cachete' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Murgati SA de CV' and p.name = 'Cachete' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Inner' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Inner' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Inner' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Buche' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Dist. de Carnes Int del Norte DYCINSA' and p.name = 'Buche' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Buche' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Buche' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'B In loin' and p.packaging_id = (select id from packaging where name = 'Combo') and p.temperature_id = (select id from temperature where name = 'Fresh') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'B In loin' and p.packaging_id = (select id from packaging where name = 'Combo') and p.temperature_id = (select id from temperature where name = 'Fresh') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Abastecedora de carnes Los Corrales' and p.name = 'Papada' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Papada' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Papada' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Abastecedora de carnes Los Corrales' and p.name = 'Grasa' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Grasa' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Grasa' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Murgati SA de CV' and p.name = 'Grasa' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Grasa' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Tocino' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Lengua' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Lengua' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Lengua' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Dist. de Carnes Int del Norte DYCINSA' and p.name = 'trompa' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Murgati SA de CV' and p.name = 'trompa' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'trompa' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'trompa' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Productos Neza' and p.name = 'trompa' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Mascara' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Productos Neza' and p.name = 'Mascara' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Bless Picnic' and p.packaging_id = (select id from packaging where name = 'Combo') and p.temperature_id = (select id from temperature where name = 'Fresh') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Bless Picnic' and p.packaging_id = (select id from packaging where name = 'Combo') and p.temperature_id = (select id from temperature where name = 'Fresh') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Abastecedora de carnes Los Corrales' and p.name = 'Cuero' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Cuero' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Recortes' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Dist. de Carnes Int del Norte DYCINSA' and p.name = 'Recortes' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Bonnacarne SA de CV' and p.name = 'Recortes' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Murgati SA de CV' and p.name = 'Recortes' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Recortes' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Recortes' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Corbata' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnicerias El Ingrato' and p.name = 'Corbata' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Corbata' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Lomo sin hueso sin cordon fresco' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Lomo sin hueso sin cordon fresco' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Pierna sin hueso' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Pierna sin hueso' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Carcass' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Carcass' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Cabeza' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Cabeza' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Cabeza' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Manita' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnicerias El Ingrato' and p.name = 'Manita' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Manita' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Manita' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Patita' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Patita' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Patita' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Recorte de Pechuga' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Murgati SA de CV' and p.name = 'Recorte de Pechuga' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Recorte de Pechuga' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Recorte de Tender' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Murgati SA de CV' and p.name = 'Recorte de Tender' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Recorte de Tender' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'PYM' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'PYM' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Alita Misscut' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Alita Misscut' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Pechuga' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Murgati SA de CV' and p.name = 'Pechuga' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Pechuga' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'WOG' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'WOG' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Pierna Bate' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Pierna Bate' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'ala entera' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'ala entera' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Empanizaldos' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Molida de pechuga' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Mollejas' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Mollejas' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Lomo con hueso' and p.packaging_id = (select id from packaging where name = 'Combo') and p.temperature_id = (select id from temperature where name = 'Fresh') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Lomo con hueso' and p.packaging_id = (select id from packaging where name = 'Combo') and p.temperature_id = (select id from temperature where name = 'Fresh') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Bonnacarne SA de CV' and p.name = 'Lomo sin hueso' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Lomo sin hueso' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Cabeza de Lomo sin hueso' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Abastecedora de carnes Los Corrales' and p.name = 'Papada' and p.packaging_id = (select id from packaging where name = 'Caja') and p.temperature_id = (select id from temperature where name = 'Frozen') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Papada' and p.packaging_id = (select id from packaging where name = 'Caja') and p.temperature_id = (select id from temperature where name = 'Frozen') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnicerias El Ingrato' and p.name = 'Papada' and p.packaging_id = (select id from packaging where name = 'Caja') and p.temperature_id = (select id from temperature where name = 'Frozen') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Murgati SA de CV' and p.name = 'Papada' and p.packaging_id = (select id from packaging where name = 'Caja') and p.temperature_id = (select id from temperature where name = 'Frozen') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Papada' and p.packaging_id = (select id from packaging where name = 'Caja') and p.temperature_id = (select id from temperature where name = 'Frozen') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Papada' and p.packaging_id = (select id from packaging where name = 'Combo') and p.temperature_id = (select id from temperature where name = 'Fresh') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Papada' and p.packaging_id = (select id from packaging where name = 'Combo') and p.temperature_id = (select id from temperature where name = 'Fresh') on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Abastecedora de carnes Los Corrales' and p.name = 'Corazon' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Dist. de Carnes Int del Norte DYCINSA' and p.name = 'Corazon' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Oreja' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Empacadora Murgati SA de CV' and p.name = 'Punta de Chuleta' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Picnic Sin Hueso' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Picnic Sin Hueso' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Tocino #2' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Tocino #2' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Sirloin' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Cushion' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'outter' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Alitas' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnicerias El Ingrato' and p.name = 'Alitas' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Alitas' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'P&M' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnicerias El Ingrato' and p.name = 'P&M' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Dist. de Carnes Int del Norte DYCINSA' and p.name = 'P&M' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'P&M' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnicerias El Ingrato' and p.name = 'Papas' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Pasta De Pollo' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Pasta De Pollo' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Empanizados' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Dist. de Carnes Int del Norte DYCINSA' and p.name = 'Empanizados' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Empanizados' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Menudo' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnicerias El Ingrato' and p.name = 'Menudo' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Carnytek SA de CV' and p.name = 'Menudo' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Menudo' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Menudo' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Pulpa Bola' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Pulpa Bola' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Pata de Res' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'La Blanquita' and p.name = 'Diezmillo' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'PROCESADORA DE CARNES DON TIMO' and p.name = 'Labio' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Clod' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
insert into customer_products (customer_id, product_id) select c.id, p.id from customers c, products p where c.trade_name = 'Aqua Terra Imports' and p.name = 'Gooseneck' and p.packaging_id is null and p.temperature_id is null on conflict do nothing;
