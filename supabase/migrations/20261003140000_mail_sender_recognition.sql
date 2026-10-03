-- Who is writing to the purchasing mailbox. A plant is recognized by its primary email, its extra contacts (email_cc), its payments
-- email, and any address a person has assigned to it here — learned once, recognized forever. An address the system cannot place is
-- recorded (never silently dropped) until a person assigns it to a plant or dismisses it.
create table plant_sender_addresses (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id) on delete cascade,
  email text not null,
  source text not null default 'assigned',
  created_by text,
  created_at timestamptz not null default now(),
  constraint plant_sender_addresses_email_lower check (email = lower(email)),
  unique (email)
);

create table mail_unrecognized_senders (
  from_email text primary key,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  times int not null default 1,
  last_subject text,
  last_message_id text,
  last_reason text not null default 'unknown_sender',
  candidates jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'assigned', 'dismissed')),
  plant_id uuid references plants(id) on delete set null,
  resolved_by text,
  resolved_at timestamptz
);
create index mail_unrecognized_senders_open_idx on mail_unrecognized_senders (last_seen desc) where status = 'open';

alter table plant_sender_addresses enable row level security;
alter table mail_unrecognized_senders enable row level security;
create policy api_service_full_access on public.plant_sender_addresses for all to api_service using (true) with check (true);
create policy api_service_full_access on public.mail_unrecognized_senders for all to api_service using (true) with check (true);
grant select, insert, update, delete on plant_sender_addresses to api_service;
grant select, insert, update on mail_unrecognized_senders to api_service;
