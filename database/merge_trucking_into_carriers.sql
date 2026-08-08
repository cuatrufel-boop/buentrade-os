-- Rellena Carriers con la info de Trucking donde faltaba (ciudad, telefono), sin duplicar filas

update freight_carriers fc
set city = coalesce(fc.city, t.city),
    phone = coalesce(fc.phone, t.phone),
    country = coalesce(fc.country, t.country)
from trucking t
where lower(fc.name) = lower(t.name);
