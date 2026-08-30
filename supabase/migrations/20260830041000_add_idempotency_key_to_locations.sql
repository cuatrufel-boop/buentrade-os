-- Standing rule (see feedback_api_idempotency_fixed_fields_by_default): every insert-capable
-- endpoint needs a real double-click/retry guard, separate from the "is this a semantic duplicate
-- of a different real city" check locations-create already does against the (city, state) unique
-- constraint. locations was missing this column entirely — added here, same pattern as
-- products/cut_names/variations/brands.
alter table locations add column idempotency_key text unique;
