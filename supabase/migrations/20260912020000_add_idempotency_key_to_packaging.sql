-- Packaging catalog is getting its own create/delete API (packaging-create, packaging-delete),
-- same pattern as cut_names/variations. Needs an idempotency_key column for the same reason those
-- two have one: safe retry on packaging-create without risking a duplicate row.
alter table packaging add column if not exists idempotency_key text;
