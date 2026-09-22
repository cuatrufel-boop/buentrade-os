-- Real ask 2026-09-21: the "Pay via Summar" QT breakdown (next step after financing_method) needs
-- to show the same Summar-fee estimate the trader saw at Create Order time — but the Payment Days
-- number that fee depends on (trading-tool.html's own quickbar field, default 40 — the trader's own
-- explained convention: 30-day customer terms + a 10-day cushion) was never persisted anywhere.
-- Without it, re-showing the estimate later would silently recompute it with a different, possibly
-- wrong number. Same reasoning and same table as financing_method: this is what was on screen at
-- the moment the trader decided, not a value to be re-derived after the fact.
--
-- Explicitly an ESTIMATE, never the real number — the customer's actual payment date (and so the
-- real Summar fee) is only known once they actually pay (see shipments.paid_days), a later
-- reconciliation step, not this one.

alter table purchase_orders
  add column payment_days integer;
