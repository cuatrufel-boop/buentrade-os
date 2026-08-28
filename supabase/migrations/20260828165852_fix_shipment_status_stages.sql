-- ============================================================================
-- fix_shipment_status_stages.sql
--
-- The 4 shipment stages built earlier (scheduled/picked_up/in_transit/delivered)
-- were invented, not sourced — a real frontend audit of offers.html's Status
-- tab (LOAD_STAGES, STAGE_MESSAGES_ES) shows the actual 4 stages the business
-- uses, each with its own real WhatsApp copy: pending_pickup, picked_up,
-- unloading, delivered. Correcting to match, before any real data exists on
-- staging that would need migrating.
-- ============================================================================

alter table shipments drop constraint shipments_status_check;
alter table shipments add constraint shipments_status_check
  check (status in ('pending_pickup', 'picked_up', 'unloading', 'delivered'));
alter table shipments alter column status set default 'pending_pickup';
alter table shipments add column unloading_at timestamptz;

alter table shipment_events drop constraint shipment_events_event_type_check;
alter table shipment_events add constraint shipment_events_event_type_check
  check (event_type in ('scheduled', 'picked_up', 'unloading', 'arriving_soon', 'delivered'));
