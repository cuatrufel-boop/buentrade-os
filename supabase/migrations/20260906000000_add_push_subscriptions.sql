-- ============================================================================
-- add_push_subscriptions.sql
--
-- Real ask 2026-09-06: "una notificacion donde yo le de ok y se ejecute" — a real-time,
-- actionable browser push notification, not a digest email. One row per (actor, browser)
-- subscription — a trader signed in on two devices gets both, and one push fans out to every
-- endpoint on file for that actor. Additive only, same pattern as every migration so far.
-- ============================================================================

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  actor text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_actor_idx on push_subscriptions(actor);

-- ============================================================================
-- End.
-- ============================================================================
