-- ============================================================================
-- seed_collections_test_orders.sql
--
-- Real ask 2026-09-14: "ponme ordenes en collections y en payments para poder probar inventalas
-- con otros clientes pon mas data" — 4 new test orders (2026-1002..1005), created via the real
-- sent-offers-create/sent-offers-mark-won APIs (see the curl calls this session), each for a
-- different real customer (never Empacadora Murgati again), advanced straight to
-- Delivered+Invoice here so Collections has real variety to test against: one not-yet-due, one
-- overdue+unsigned, two signed (one to be fully paid, one partially — via the real
-- shipments-apply-payment API right after this migration, not faked here).
-- ============================================================================

update purchase_orders set total_cost = 40000 * 1.30 where order_number in ('2026-1002','2026-1003','2026-1004','2026-1005');
update sales_orders set total_sale = 40000 * 1.46 where order_number in ('2026-1002','2026-1003','2026-1004','2026-1005');

-- 2026-1002 (DYCINSA): delivered recently, invoice sent, NOT signed, NOT paid — within terms, not overdue yet.
update shipments set
  status = 'delivered', po_sent_at = now() - interval '10 days', so_sent_at = now() - interval '10 days',
  picked_up_at = now() - interval '9 days', customs_sent_at = now() - interval '8 days',
  delivered_at = now() - interval '5 days', payment_due_date = (current_date + interval '25 days')::date,
  invoice_sent_at = now() - interval '5 days', invoice_signed_at = null, sale_amount = 40000 * 1.46
where order_number = '2026-1002';

-- 2026-1003 (Aqua Terra Imports): delivered + invoice sent + SIGNED, NOT paid, well past the
-- 30-day term — overdue, should blink red in Collections.
update shipments set
  status = 'delivered', po_sent_at = now() - interval '50 days', so_sent_at = now() - interval '50 days',
  picked_up_at = now() - interval '49 days', customs_sent_at = now() - interval '48 days',
  delivered_at = now() - interval '45 days', payment_due_date = (current_date - interval '15 days')::date,
  invoice_sent_at = now() - interval '45 days', invoice_signed_at = now() - interval '44 days',
  invoice_signed_by = 'Aqua Terra Imports', sale_amount = 40000 * 1.46
where order_number = '2026-1003';

-- 2026-1004 (Bonnacarne): delivered + invoice sent + SIGNED — payment applied right after this
-- migration via the real shipments-apply-payment API (fully paid).
update shipments set
  status = 'delivered', po_sent_at = now() - interval '20 days', so_sent_at = now() - interval '20 days',
  picked_up_at = now() - interval '19 days', customs_sent_at = now() - interval '18 days',
  delivered_at = now() - interval '15 days', payment_due_date = (current_date + interval '15 days')::date,
  invoice_sent_at = now() - interval '15 days', invoice_signed_at = now() - interval '14 days',
  invoice_signed_by = 'Bonnacarne', sale_amount = 40000 * 1.46
where order_number = '2026-1004';

-- 2026-1005 (Carnicerias El Ingrato): delivered + invoice sent + SIGNED — partial payment applied
-- right after this migration via the real shipments-apply-payment API.
update shipments set
  status = 'delivered', po_sent_at = now() - interval '18 days', so_sent_at = now() - interval '18 days',
  picked_up_at = now() - interval '17 days', customs_sent_at = now() - interval '16 days',
  delivered_at = now() - interval '13 days', payment_due_date = (current_date + interval '17 days')::date,
  invoice_sent_at = now() - interval '13 days', invoice_signed_at = now() - interval '12 days',
  invoice_signed_by = 'Carnicerias El Ingrato', sale_amount = 40000 * 1.46
where order_number = '2026-1005';

-- ============================================================================
-- End.
-- ============================================================================
