-- ============================================================================
-- reset_bt0019_invoice_sent.sql
--
-- Real data fix 2026-09-14: order BT-0019 (Empacadora Murgati) had invoice_sent_at set to
-- 2026-09-05T11:47:23Z with no real PDF ever uploaded to storage under any known filename
-- (confirmed live: INV-BT-0019.pdf and INV-BT-BT-0019.pdf both 404) — a phantom "sent" flag from
-- earlier test data, blocking the trader from actually generating/sending the real invoice and
-- reaching Signature. One-off targeted reset, this specific order only.
-- ============================================================================

update shipments set invoice_sent_at = null where order_number = 'BT-0019' and invoice_signed_at is null;

-- ============================================================================
-- End.
-- ============================================================================
