-- ============================================================================
-- add_payments_contact_to_plants.sql
--
-- Real correction 2026-09-06: "en todas las plantas es una persona distinta a la que vendio la
-- carga la que recibe el recibo de pago... tengo que poder enviarlo a esa persona copiando a la
-- que me vendio la carga" — every plant has a separate Accounts/Payments contact, distinct from
-- the sales contact (plants.contact_name/email/whatsapp). The payment confirmation email now goes
-- TO this new contact, CC'd to the existing sales contact — not the other way around, and not
-- guessed as the same person.
-- ============================================================================

alter table plants add column payments_contact_name text;
alter table plants add column payments_email text;
alter table plants add column payments_whatsapp text;

-- ============================================================================
-- End.
-- ============================================================================
