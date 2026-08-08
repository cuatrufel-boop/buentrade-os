-- Paso 1: agrega a plants los campos que solo existian en suppliers
alter table plants add column if not exists website text;
alter table plants add column if not exists payment_terms text;
alter table plants add column if not exists required_documentation text;
alter table plants add column if not exists avg_response_time text;

-- Paso 2: para las 18 plantas que ya existen, copia esos campos desde su supplier
update plants p
set website = s.website,
    payment_terms = s.payment_terms,
    required_documentation = s.required_documentation,
    avg_response_time = s.avg_response_time
from suppliers s
where p.supplier_id = s.id;

-- Paso 3: crea una planta para cada supplier que todavia no tiene una,
-- copiando todos sus datos (nombre, ciudad, contacto, etc.)
insert into plants (supplier_id, name, country, state, city, contact_name, email, phone, website, payment_terms, required_documentation, avg_response_time, notes)
select s.id, s.name, s.country, s.state, s.city, s.contact_name, s.email, s.phone, s.website, s.payment_terms, s.required_documentation, s.avg_response_time, s.notes
from suppliers s
where not exists (select 1 from plants p where p.supplier_id = s.id);
