-- What the system understood from each client note, 2026-09-29 (user: "ese campo de notas debe ser super sensible
-- y básico, de ahí debe salir todo lo sensible para llegarle al cliente; lo que no entiende lo deja en pending para
-- aprobación y en el producto queda como respaldo, al igual que en los otros módulos").
--   kind 'cadence' — how often they buy one of THEIR products. Clear → applied straight to customer_products (the
--                    Products tab dropdown shows it; `before_*` keeps the previous value so it can be undone).
--                    Unclear (which product? fresh or frozen? not in their products?) → pending until the trader picks.
--   kind 'fact'    — anything else worth knowing to reach them (personal, business, preference, payment).
-- Deleting the note deletes what was understood from it (the cadence already applied stays, like any saved value).
create table customer_note_insights (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references customer_notes(id) on delete cascade,
  customer_id uuid not null references customers(id),
  kind text not null check (kind in ('cadence', 'fact')),
  topic text check (topic in ('personal', 'business', 'preference', 'payment')),
  status text not null check (status in ('applied', 'pending', 'dismissed', 'undone')),
  summary_en text not null,          -- what was understood, in plain English, shown to the trader
  question_en text,                  -- pending only: what the system could not decide
  link_id uuid references customer_products(id) on delete set null,
  candidate_link_ids uuid[] not null default '{}',
  frequency_days int check (frequency_days > 0),
  loads_per_cycle int check (loads_per_cycle > 0),
  before_frequency_days int,
  before_loads_per_cycle int,
  created_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz
);
create index customer_note_insights_customer on customer_note_insights (customer_id, created_at desc);
create index customer_note_insights_pending on customer_note_insights (status) where status = 'pending';
alter table customer_notes add column insights_status text check (insights_status in ('done', 'failed'));
grant select, insert, update on customer_note_insights to api_service;
