-- Corrige transportistas que se colaron en Suppliers (venían mal categorizados en el archivo origen)

-- 1) Eliminar de Suppliers
delete from suppliers where name in (
  '3 Points Logistics LLC',
  'XPO Logistics Inc.',
  'Sunbelt Logistics Group',
  'Pyle Transportation Inc.',
  'Millenium Logistics',
  'M&G Trucking',
  'Lineage Transportation LLC',
  'Grace Logistics Inc.',
  'Freight Lane Solutions LLC',
  'D&L Transport',
  'Best Bay Logistics',
  'Key Global Logistics',
  'AA Supplier'
);

-- 2) Agregar a Freight Carriers los que no estaban ya ahí
insert into freight_carriers (name, country, city, contact_name, email) values ('3 Points Logistics LLC', 'United States', 'Texas', 'Alondra Martinez', 'logistic@3pointsllc.com');
insert into freight_carriers (name, country, city, contact_name, email) values ('XPO Logistics Inc.', 'United States', 'TX', 'Ethan Souther', 'ethan.souther@xpologistics.com');
insert into freight_carriers (name, country, city, contact_name, email) values ('Sunbelt Logistics Group', 'United States', 'ON', 'Deep Pannu', 'deep@sunbeltlogistics.com');
insert into freight_carriers (name, country, city, contact_name, email) values ('Pyle Transportation Inc.', 'United States', 'IL', 'Rhonda Pyle', 'rjpyle_@hotmail.com');
insert into freight_carriers (name, country, city, contact_name, email) values ('Millenium Logistics', 'United States', 'MT', 'Millenium Logistics', 'sofiya@millenniumlogistics.us');
insert into freight_carriers (name, country, city, contact_name, email) values ('M&G Trucking', 'United States', 'TX', 'Rey Ayala', 'reyayalajr@hotmail.com');
insert into freight_carriers (name, country, city, contact_name, email) values ('Lineage Transportation LLC', 'United States', 'MI', 'Evan Beattie', 'ebeattie@onelineage.com');
insert into freight_carriers (name, country, city, contact_name, email) values ('Grace Logistics Inc.', 'United States', 'CA', 'Marcus Lyon', 'marcus.s@gracelogisticsinc.com');
insert into freight_carriers (name, country, city, contact_name, email) values ('Freight Lane Solutions LLC', 'United States', 'OH', 'Andrew Jahnz', 'ajahnz@freightlane.com');
insert into freight_carriers (name, country, city, contact_name, email) values ('D&L Transport', 'United States', 'KS', 'Tom Charters', 'tcharters@dltransport.com');
