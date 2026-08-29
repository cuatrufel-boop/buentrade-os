-- sent-offers-mark-won is the single highest-stakes write in the whole system — one call creates
-- a purchase_order, a sales_order, up to two freight_orders, up to two order_extra_costs rows, a
-- shipment, and a shipment_event, all in one transaction. It already refuses a second call once
-- the offer's status has flipped away from 'sent' (a real, working guard against a *sequential*
-- retry), but that check happens before the transaction starts, so two requests arriving close
-- enough together could both pass it before either commits. A dedicated idempotency key (separate
-- from sent_offers.idempotency_key, which belongs to the CREATE step, not the WIN step) closes
-- that gap the same way every other create-style write in this system does.
alter table sent_offers add column if not exists won_idempotency_key text;

-- plant_documents.upload always writes a new row (the storage path includes a random UUID by
-- design, so re-uploading the same file is never meant to overwrite) — a genuine double-click on
-- Upload would otherwise record the same document twice.
alter table plant_documents add column if not exists idempotency_key text;
