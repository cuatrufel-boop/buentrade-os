-- Tracks which Gmail messages the email-ingestion poller has already handled, keyed by Gmail's
-- own message id — the poller re-scans recent mail every run, and without this it would re-apply
-- (or re-queue) the same lines every single time it runs. Not a content log (no body stored) —
-- just enough to answer "have I seen this one before" and give a basic per-run count for
-- visibility, matching the explicit ask to not over-load this with data that isn't needed.
create table plant_price_emails_processed (
  message_id text primary key,
  plant_id uuid references plants(id),
  from_email text,
  subject text,
  processed_at timestamptz not null default now(),
  lines_applied int not null default 0,
  lines_pending int not null default 0,
  lines_skipped int not null default 0
);

alter table plant_price_emails_processed enable row level security;
create policy api_service_full_access on public.plant_price_emails_processed for all to api_service using (true) with check (true);
