-- Payments module. Real ask: every payment now records the date it actually entered the bank
-- and which of the two real collection accounts (Buentrade / Summar) received it. payment_batch_id
-- groups the rows one trader submission creates (one payment can split across several shipments,
-- one row per shipment slice already, see create_payment_applications) so the new Payments ledger
-- can show "one payment -> N invoices" instead of N disconnected rows.
alter table payment_applications
  add column payment_batch_id uuid,
  add column bank_entry_date date,
  add column collection_account text check (collection_account in ('Buentrade', 'Summar'));

create index payment_applications_batch_id_idx on payment_applications(payment_batch_id);
