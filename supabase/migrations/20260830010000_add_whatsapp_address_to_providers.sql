-- Real gap confirmed live (2026-08-30): providers had no whatsapp number field at all (only
-- whatsapp_cc, a notification CC list, not a contact number) and no street address — plants and
-- customers both already have both. A trader can't reliably WhatsApp a carrier/customs broker
-- without a real number on file, separate from the CC list.
alter table providers add column if not exists whatsapp text;
alter table providers add column if not exists address text;
