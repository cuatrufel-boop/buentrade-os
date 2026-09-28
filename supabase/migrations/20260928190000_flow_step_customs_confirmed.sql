-- Pay & Receive, 2026-09-28: the customs bill is confirmed in the flow (extra charges added from
-- the dropdown, or none) before it can be paid — same as the freight bill. 'customs_deferred' stays
-- allowed only for the rows already written; the flow no longer offers it (the agency's payment
-- terms decide when customs is paid).
alter table shipment_flow_steps drop constraint shipment_flow_steps_step_check;
alter table shipment_flow_steps add constraint shipment_flow_steps_step_check
  check (step in ('freight_confirmed', 'customs_confirmed', 'customer_reminder_sent', 'customs_deferred'));
