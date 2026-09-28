-- Pay & Receive, 2026-09-28 ("debo poder dejarlos pendientes completos o pagarlos de una vez"):
-- at the Pay Customs step the trader either pays the agency in full or leaves it pending in full —
-- 'customs_deferred' lets the flow move on while the customs bill stays open (never partial).
alter table shipment_flow_steps drop constraint shipment_flow_steps_step_check;
alter table shipment_flow_steps add constraint shipment_flow_steps_step_check
  check (step in ('freight_confirmed', 'customer_reminder_sent', 'customs_deferred'));
