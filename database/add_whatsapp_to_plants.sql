alter table plants add column if not exists whatsapp text;

update plants
set whatsapp = '712-294-4221'
where name = 'Perdue Premium Meat Company';
