-- Companion to release_number (added moments earlier): tracks whether the recorded release number
-- was actually relayed to the carrier yet, same "N_sent_at" pattern as po_sent_at/so_sent_at/
-- fo_sent_at/customs_sent_at/invoice_sent_at — every other real send in this flow gets one.
alter table shipments add column release_number_sent_at timestamptz;
