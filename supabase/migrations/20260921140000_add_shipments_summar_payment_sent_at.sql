-- Real ask 2026-09-21: "Pay via Summar" flow, step 2 — orders.html sends the SO + Grove Bank
-- payment confirmation to Summar (marango@summar.com), asking them to confirm once they've paid
-- the plant. Tracked the same way every other document send is (po_sent_at/so_sent_at/fo_sent_at
-- via shipments-mark-doc-sent) — see that function's doc_type enum, extended alongside this.
--
-- Summar's own confirmation back to BuenTrade that they paid the plant reuses plant_paid_at
-- (already means "the plant has been paid," regardless of who paid them) — no new column needed
-- for that step, it's the same field/downstream logic (Release Number request) as the direct-pay
-- flow, untouched.

alter table shipments
  add column summar_payment_sent_at timestamptz;
