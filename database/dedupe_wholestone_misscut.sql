-- Unifica Wholestone Farms dentro de Wholestone Prestage LLC (la que tiene productos/fotos)
update plants
set contact_name = coalesce(contact_name, (select contact_name from plants where name = 'Wholestone Farms')),
    email = coalesce(email, (select email from plants where name = 'Wholestone Farms')),
    phone = coalesce(phone, (select phone from plants where name = 'Wholestone Farms')),
    address = coalesce(address, (select address from plants where name = 'Wholestone Farms')),
    state = coalesce(state, (select state from plants where name = 'Wholestone Farms')),
    country = coalesce(country, (select country from plants where name = 'Wholestone Farms'))
where name = 'Wholestone Prestage LLC';

delete from plants where name = 'Wholestone Farms';

-- Borra Alita Misscut (vacia, sin foto ni marca) - se queda Ala Misscut (completa)
delete from products where id = '428670bc-1369-4810-b21f-3b1c7948f806';
