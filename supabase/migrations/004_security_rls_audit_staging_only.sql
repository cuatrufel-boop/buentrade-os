-- ============================================================================
-- 004_security_rls_audit_staging_only.sql
--
-- STAGING ONLY (project geqhjykbxvxugvnpnygn). The security backbone: a
-- dedicated non-owner role for the future API, RLS forced on every table
-- (not just enabled — see note below), an append-only tamper-evident audit
-- log, and a human-approval queue for sensitive actions.
--
-- Why FORCE and not just ENABLE: `postgres` (the role used to build this
-- schema) and any role with BYPASSRLS silently ignores every RLS policy no
-- matter what the policy says — this was confirmed directly during today's
-- audit (my own connection ignored every policy all session). ENABLE alone
-- protects nothing against a role like that. FORCE closes that gap for
-- every role except a literal superuser/BYPASSRLS role — which is exactly
-- why the future Edge Functions must connect as `api_service`, never as
-- `postgres` or Supabase's `service_role`.
--
-- Password for api_service is generated and saved locally (scratchpad,
-- chmod 600), not committed to this repo and not printed in full here.
-- ============================================================================

create role api_service with login password 'REPLACED_AT_APPLY_TIME';

-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash-chained. api_service can INSERT and SELECT —
-- never UPDATE or DELETE, enforced both by RLS policy (no update/delete
-- policy exists at all) and by a plain REVOKE below, so the guarantee holds
-- even if a future policy mistake is made.
--
-- The hash chain itself (prev_hash + hash) is computed by the Edge Function
-- code at insert time, not by a DB trigger — a trigger's logic can be
-- altered by anyone with schema privileges, so the real guarantee is
-- "this table can only grow, never be edited," not "Postgres itself can't
-- be tampered with by a superuser" (a deeper problem, accepted as out of
-- scope for this layer).
-- ---------------------------------------------------------------------------
create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  table_name text not null,
  record_id text not null,
  before jsonb,
  after jsonb,
  prev_hash text,
  hash text not null
);
create index audit_log_table_record_idx on audit_log (table_name, record_id);
create index audit_log_at_idx on audit_log (at desc);

-- ---------------------------------------------------------------------------
-- Human approval queue: a sensitive action (destructive, ambiguous, or
-- flagged by business-rule logic in an Edge Function) is written here
-- instead of executed directly. Nothing acts on a pending row until a
-- human approves it through the UI, which itself is just another
-- Edge Function call that flips status to 'approved' and then performs
-- the original action.
-- ---------------------------------------------------------------------------
create table pending_approvals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  requested_by text not null,
  action_type text not null,
  table_name text,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  notes text
);
create index pending_approvals_status_idx on pending_approvals (status);

-- ---------------------------------------------------------------------------
-- Baseline grants: api_service can read/write every table that exists now,
-- and every table created from here on (default privileges) — narrowed
-- back down for audit_log specifically, right below.
-- ---------------------------------------------------------------------------
grant usage on schema public to api_service;
grant select, insert, update, delete on all tables in schema public to api_service;
grant usage, select on all sequences in schema public to api_service;
alter default privileges in schema public grant select, insert, update, delete on tables to api_service;
alter default privileges in schema public grant usage, select on sequences to api_service;

revoke update, delete on audit_log from api_service;

-- ---------------------------------------------------------------------------
-- RLS, forced, on every table in the schema — generic policy first
-- (api_service, full access), then audit_log gets overridden right after
-- with the narrower insert-only + read-only pair.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists api_service_full_access on public.%I', t);
    execute format(
      'create policy api_service_full_access on public.%I for all to api_service using (true) with check (true)',
      t
    );
  end loop;
end $$;

drop policy api_service_full_access on audit_log;
create policy api_service_insert on audit_log for insert to api_service with check (true);
create policy api_service_read on audit_log for select to api_service using (true);

-- ============================================================================
-- End of 004.
-- ============================================================================
