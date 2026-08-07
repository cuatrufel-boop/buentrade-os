-- Corrige categorías de productos (2026-08-07):
-- 1) Prop 12 no es una proteína -- es una certificación de Cerdo.
-- 2) 'Cerdo y Pollo' no es válido como categoría de un producto individual --
--    se reclasifica cada uno por su nombre real (Cerdo/Pollo/Res).

update products set category = 'Cerdo', commercial_notes = coalesce(commercial_notes || ' | ', '') || 'Prop 12 compliant' where category = 'Prop 12';

update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Alitas';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Alita Misscut';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'ala entera';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Pechuga';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Recorte de Pechuga';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Molida de pechuga';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Recorte de Tender';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'WOG';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Pierna Bate';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'P&M';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Empanizaldos';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Empanizados';
update products set category = 'Pollo' where category = 'Cerdo y Pollo' and name = 'Mollejas';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Papada';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Corbata';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Manita';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Patita';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Tocino';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Tocino #2';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Cushion';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Picnic Sin Hueso';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Bless Picnic';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Lomo sin hueso';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Lomo con hueso';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Cabeza de Lomo sin hueso';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Lomo sin hueso sin cordon fresco';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'B In loin';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Pierna sin hueso';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Punta de Chuleta';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Heart';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Inner';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Buche';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Grasa';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Lengua';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'trompa';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Mascara';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Cuero';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Recortes';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Carcass';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Cabeza';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'outter';
update products set category = 'Cerdo' where category = 'Cerdo y Pollo' and name = 'Labio';
update products set category = 'Res' where category = 'Cerdo y Pollo' and name = 'Pata de Res';
update products set category = 'Res' where category = 'Cerdo y Pollo' and name = 'Diezmillo';
update products set category = 'Res' where category = 'Cerdo y Pollo' and name = 'Clod';
update products set category = 'Res' where category = 'Cerdo y Pollo' and name = 'Gooseneck';
update products set category = 'Res' where category = 'Cerdo y Pollo' and name = 'Sirloin';
update products set category = 'Res' where category = 'Cerdo y Pollo' and name = 'Menudo';
update products set category = 'Res' where category = 'Cerdo y Pollo' and name = 'Pulpa Bola';
update products set category = 'Res' where category = 'Cerdo y Pollo' and name = 'Corazon';

-- 'Papas' queda sin clasificar -- no encaja en Cerdo/Pollo/Res, revisar manualmente
update products set commercial_notes = coalesce(commercial_notes || ' | ', '') || 'REVISAR: categoría no determinada' where category = 'Cerdo y Pollo' and name = 'Papas';
