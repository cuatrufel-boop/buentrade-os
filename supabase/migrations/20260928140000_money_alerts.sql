-- Pay & Receive money alerts (2026-09-28, "de ahi debemos empezar a notificar in and outs de
-- dinero de esa carga hasta que el cliente pague... que el trader sea responsable"): the same
-- push + email the trader already gets for Orders steps (shipment-alerts-poll), now for each money
-- step of a load once it entered Pay & Receive. One row per (load, alert) = sent once, never twice.
create table money_alerts_sent (
  shipment_id uuid not null references shipments(id),
  alert_key text not null,
  sent_at timestamptz not null default now(),
  primary key (shipment_id, alert_key)
);
grant select, insert on money_alerts_sent to api_service;
