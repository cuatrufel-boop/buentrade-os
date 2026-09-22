-- Real ask 2026-09-21: "el sistema nos pregunta como la queremos comprar si directa o por
-- factoring" — trading-tool.html's Create Order flow now asks the trader to choose how BuenTrade
-- pays the plant for this purchase, right before the order is created. This is step 1 of a larger,
-- explicitly deferred roadmap (Pay Summar button, PO+SO+receipt email to Summar, reconciliation,
-- etc.) — this migration only adds the field to record the choice; nothing downstream (PO/SO/FO/
-- Invoice generation, bank details) reacts to it yet.
--
-- Lives on purchase_orders (not sales_orders or shipments) because Summar factoring finances the
-- PURCHASE side only — how BuenTrade pays the plant, never the customer-facing sale price or terms.
--
-- Defaults to 'direct' (not nullable) so every existing row, and any other call site that doesn't
-- yet send this (offers.html's own quick "Ganada" button also calls sent-offers-mark-won), keeps
-- behaving exactly as it always has.

alter table purchase_orders
  add column financing_method text not null default 'direct'
  check (financing_method in ('direct', 'summar'));
