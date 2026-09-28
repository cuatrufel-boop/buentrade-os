-- Pay & Receive, 2026-09-28 ("si los fletes de cada carga tuvieron sobrecostos debo poder
-- adherirlos y saber al final del corte cuanto se le paga... igual que aduanas"): a surcharge
-- added to a load is an order_extra_costs row (so it already counts in profit, same as every
-- extra cost) that also says WHOSE bill it belongs on — the carrier's freight bill or the
-- customs bill — so the carrier / customs statement at the month's cutoff = base + surcharges.
alter table order_extra_costs add column payable_kind text check (payable_kind in ('freight', 'customs'));
alter table order_extra_costs add column actor text;
create unique index if not exists order_extra_costs_idempotency on order_extra_costs (idempotency_key) where idempotency_key is not null;
grant select, insert on order_extra_costs to api_service;
