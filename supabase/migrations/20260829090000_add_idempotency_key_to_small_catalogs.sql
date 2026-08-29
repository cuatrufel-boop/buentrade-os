-- brands/variations/cut_names were built without an idempotency_key column — the only other
-- catalog-create endpoints in the system without one. Brand relies on its own `name` unique
-- constraint to survive a duplicate submit, but variations/cut_names have no such constraint at
-- all, so a double-click (or network retry) that lands as two near-simultaneous requests could
-- create two identical rows. Brings all three in line with the standing rule (permanent, applies
-- to everything built from now on): idempotent from day one, not a later cleanup pass.
alter table brands add column if not exists idempotency_key text;
alter table variations add column if not exists idempotency_key text;
alter table cut_names add column if not exists idempotency_key text;
