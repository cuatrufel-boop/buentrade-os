-- Se me quedaron 4 productos fuera de la primera corrección por error.

update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Cachete';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Oreja';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'PYM';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Pasta De Pollo';
