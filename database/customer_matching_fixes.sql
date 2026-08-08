-- Borra el duplicado de La Blanquita (mismo cliente, SLP)
delete from customers where id = '3365fcbc-ce2b-4431-ba85-40db20744a0b';

-- Crea Arch Meat (cliente nuevo, no existia)
insert into customers (trade_name)
values ('Arch Meat');
