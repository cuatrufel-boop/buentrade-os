-- Control ledger for plant price emails: one row per candidate line a reader SAW in a message
-- (a priced item, a row with no price, a formula, an unreadable picture, an attachment it cannot read...)
-- and what became of it. outcome 'dropped' means the reader saw it and put it NOWHERE — that is the
-- leak the system must never have; the view below makes every message add up (candidates = applied +
-- pending + declined + dropped), and "dropped" must be 0.
create table plant_price_email_lines (
  id uuid primary key default gen_random_uuid(),
  message_id text not null,
  plant_id uuid not null references plants(id) on delete cascade,
  source text not null check (source in ('body', 'xlsx', 'image', 'attachment', 'declined')),
  line_key text not null,
  raw_text text not null,
  detected_price numeric,
  outcome text not null check (outcome in ('applied', 'pending', 'declined', 'dropped')),
  reason_code text,
  reason_detail text,
  pending_match_id uuid references plant_pending_matches(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, line_key)
);

create index plant_price_email_lines_plant_idx on plant_price_email_lines (plant_id, outcome);

alter table plant_price_email_lines enable row level security;
create policy api_service_full_access on public.plant_price_email_lines for all to api_service using (true) with check (true);
grant select, insert, update on plant_price_email_lines to api_service;

create view plant_price_email_reconciliation as
select
  l.message_id,
  l.plant_id,
  p.subject,
  p.processed_at,
  count(*)                                      as candidates,
  count(*) filter (where l.outcome = 'applied')  as applied,
  count(*) filter (where l.outcome = 'pending')  as pending,
  count(*) filter (where l.outcome = 'declined') as declined,
  count(*) filter (where l.outcome = 'dropped')  as dropped
from plant_price_email_lines l
left join plant_price_emails_processed p on p.message_id = l.message_id
group by l.message_id, l.plant_id, p.subject, p.processed_at;

grant select on plant_price_email_reconciliation to api_service;
