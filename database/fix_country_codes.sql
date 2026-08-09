-- Todo Krioyo: pais real es Colombia (el telefono ya es +57)
update customers set country = 'Colombia' where trade_name = 'Todo Krioyo';

-- Case Farms: pais real es United States (telefono NC ya es +1), agrega el signo +
update plants set country = 'United States', phone = '+1 7045284501' where name = 'Case Farms';

-- Perdue Premium Meat Company: pais United States + codigo +1 en telefono y whatsapp
update plants
set country = 'United States',
    phone = '+1 712-224-9862',
    whatsapp = '+1 712-294-4221'
where name = 'Perdue Premium Meat Company';

-- Total Quality Logistics: limpia el "+null" que quedo pegado
update freight_carriers set phone = '+1 312-834-2979' where name = 'Total Quality Logistics';
