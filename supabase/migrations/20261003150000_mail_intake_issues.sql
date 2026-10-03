-- Mail from a known plant or carrier that a reader could not finish (an attachment that would not save, a reply to a release-number
-- request with no number in it...). Open until it is handled; a retry that succeeds closes it by itself. One row per message + handler.
create table mail_intake_issues (
  id uuid primary key default gen_random_uuid(),
  message_id text not null,
  handler text not null check (handler in ('pickup_docs', 'release_number')),
  from_email text not null,
  subject text,
  reason_code text not null,
  reason_detail text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  unique (message_id, handler)
);
create index mail_intake_issues_open_idx on mail_intake_issues (created_at desc) where resolved_at is null;
alter table mail_intake_issues enable row level security;
create policy api_service_full_access on public.mail_intake_issues for all to api_service using (true) with check (true);
grant select, insert, update on mail_intake_issues to api_service;
