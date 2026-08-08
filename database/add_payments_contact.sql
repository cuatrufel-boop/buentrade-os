-- Agrega un contacto de pagos separado del contacto de compras en Customers.
-- Motivo: en la operación real, la persona que compra y la persona que
-- gestiona pagos/cobranza suelen ser distintas.

alter table customers add column payments_contact_name text;
alter table customers add column payments_contact_email text;
alter table customers add column payments_contact_phone text;
alter table customers add column payments_contact_whatsapp text;
