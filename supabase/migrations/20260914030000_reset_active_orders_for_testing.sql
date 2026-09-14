-- ============================================================================
-- reset_active_orders_for_testing.sql
--
-- Real ask 2026-09-14: "resetea todas las ordenes activas con lo nuevo para poder ver flujos y
-- poder avanzar... deja una en cada paso asi pruebo todo y en especial quiero probar la firma."
-- Test-data reset only (these are all early test orders, not real production shipments) — one
-- order per major checkpoint of the real flow, so each step can be exercised directly with
-- today's fixes instead of fighting stale/inconsistent state left over from earlier sessions.
--
-- BT-0013 -> fresh, nothing sent yet                         (test: Send PO)
-- BT-0014 -> PO sent, SO not sent                             (test: Send SO)
-- BT-0015 -> PO+SO sent, plant not paid                       (test: Pay Plant)
-- BT-0017 -> PO+SO+FO sent, plant paid, no release # yet      (test: Record Release #)
-- BT-0018 -> release # recorded, ready to Confirm PU          (test: Confirm PU / physical pickup)
-- BT-0019 -> picked up, no customs docs requested yet         (test: Customs docs / Sent to customs)
-- 2026-1001 -> delivered, customs sent, invoice not sent yet  (test: Invoice -> Signature)
-- ============================================================================

update shipments set
  status = 'pending_pickup', po_sent_at = null, so_sent_at = null, fo_sent_at = null,
  plant_paid_at = null, release_number = null, release_number_sent_at = null,
  picked_up_at = null, customs_sent_at = null, delivered_at = null, payment_due_date = null,
  invoice_sent_at = null, invoice_signed_at = null
where order_number = 'BT-0013';

update shipments set
  status = 'pending_pickup', po_sent_at = now() - interval '2 hours', so_sent_at = null, fo_sent_at = null,
  plant_paid_at = null, release_number = null, release_number_sent_at = null,
  picked_up_at = null, customs_sent_at = null, delivered_at = null, payment_due_date = null,
  invoice_sent_at = null, invoice_signed_at = null
where order_number = 'BT-0014';

update shipments set
  status = 'pending_pickup', po_sent_at = now() - interval '1 day', so_sent_at = now() - interval '23 hours', fo_sent_at = null,
  plant_paid_at = null, release_number = null, release_number_sent_at = null,
  picked_up_at = null, customs_sent_at = null, delivered_at = null, payment_due_date = null,
  invoice_sent_at = null, invoice_signed_at = null
where order_number = 'BT-0015';

update shipments set
  status = 'pending_pickup',
  po_sent_at = now() - interval '2 days', so_sent_at = now() - interval '2 days', fo_sent_at = now() - interval '2 days',
  plant_paid_at = now() - interval '1 day', release_number = null, release_number_sent_at = null,
  picked_up_at = null, customs_sent_at = null, delivered_at = null, payment_due_date = null,
  invoice_sent_at = null, invoice_signed_at = null
where order_number = 'BT-0017';

update shipments set
  status = 'pending_pickup',
  po_sent_at = now() - interval '3 days', so_sent_at = now() - interval '3 days', fo_sent_at = null,
  plant_paid_at = now() - interval '2 days', release_number = 'REL-TEST-0018', release_number_sent_at = null,
  picked_up_at = null, customs_sent_at = null, delivered_at = null, payment_due_date = null,
  invoice_sent_at = null, invoice_signed_at = null
where order_number = 'BT-0018';

update shipments set
  status = 'picked_up',
  po_sent_at = now() - interval '4 days', so_sent_at = now() - interval '4 days', fo_sent_at = now() - interval '4 days',
  plant_paid_at = now() - interval '3 days', release_number = 'REL-TEST-0019', release_number_sent_at = now() - interval '3 days',
  picked_up_at = now() - interval '2 days', customs_sent_at = null, delivered_at = null, payment_due_date = null,
  invoice_sent_at = null, invoice_signed_at = null
where order_number = 'BT-0019';

update shipments set
  status = 'delivered',
  po_sent_at = now() - interval '6 days', so_sent_at = now() - interval '6 days', fo_sent_at = now() - interval '6 days',
  plant_paid_at = now() - interval '5 days', release_number = 'REL-TEST-1001', release_number_sent_at = now() - interval '5 days',
  picked_up_at = now() - interval '4 days', customs_sent_at = now() - interval '3 days', delivered_at = now() - interval '1 day',
  payment_due_date = (current_date + interval '30 days')::date,
  invoice_sent_at = null, invoice_signed_at = null
where order_number = '2026-1001';

-- Real pickup-document rows and alert-tracking timestamps could otherwise leave a "done" mini-step
-- looking pending or vice versa — cleared for every one of these 7 test orders so each one's own
-- gating matches exactly the state set above, nothing left over from earlier test rounds.
delete from shipment_pickup_documents where order_number in ('BT-0013','BT-0014','BT-0015','BT-0017','BT-0018','BT-0019','2026-1001');
update shipments set
  pre_pickup_alert_sent_at = null, missed_pickup_alert_sent_at = null, plant_payment_alert_sent_at = null,
  release_number_alert_sent_at = null, pickup_docs_alert_sent_at = null, border_overdue_alert_sent_at = null,
  docs_ready_alert_sent_at = null
where order_number in ('BT-0013','BT-0014','BT-0015','BT-0017','BT-0018','BT-0019','2026-1001');

-- ============================================================================
-- End.
-- ============================================================================
