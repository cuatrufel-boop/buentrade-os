-- ============================================================================
-- 20260928100000_provider_rate_history.sql
--
-- Messaging trigger "fletes" (2026-09-28): a freight rate that went up or down is a reason to write to the clients it
-- affects — but provider_rates only keeps the current rate, so a change was invisible. Every change is now kept, by a
-- trigger, whatever screen or function wrote it (same idea as price_history for plant prices).
-- ============================================================================
create table provider_rate_history (
  id uuid primary key default gen_random_uuid(),
  rate_id uuid not null references provider_rates(id) on delete cascade,
  provider_id uuid, plant_id uuid, location_id uuid, service_type text, origin text, destination text,
  old_rate numeric, new_rate numeric, currency text,
  changed_at timestamptz not null default now()
);
create index provider_rate_history_changed_idx on provider_rate_history(changed_at desc);

create or replace function log_provider_rate_change() returns trigger language plpgsql as $$
begin
  if (tg_op = 'UPDATE' and new.rate is distinct from old.rate) then
    insert into provider_rate_history (rate_id, provider_id, plant_id, location_id, service_type, origin, destination, old_rate, new_rate, currency)
    values (new.id, new.provider_id, new.plant_id, new.location_id, new.service_type, new.origin, new.destination, old.rate, new.rate, new.currency);
  elsif (tg_op = 'INSERT') then
    insert into provider_rate_history (rate_id, provider_id, plant_id, location_id, service_type, origin, destination, old_rate, new_rate, currency)
    values (new.id, new.provider_id, new.plant_id, new.location_id, new.service_type, new.origin, new.destination, null, new.rate, new.currency);
  end if;
  return new;
end $$;
create trigger provider_rates_history after insert or update of rate on provider_rates
  for each row execute function log_provider_rate_change();
grant select on provider_rate_history to api_service;
grant insert on provider_rate_history to api_service;
