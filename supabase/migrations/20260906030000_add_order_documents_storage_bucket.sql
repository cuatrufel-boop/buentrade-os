-- ============================================================================
-- add_order_documents_storage_bucket.sql
--
-- Critical bug found live 2026-09-06 testing the Won -> PO flow end to end (in response to "dame
-- la prueba"): the "order-documents" storage bucket that PO/SO/FO/Customs/Invoice PDFs all upload
-- to (offers.html's uploadOrderPdf) never actually existed on this project. Every send silently
-- died at the upload step, before the trader ever saw the review modal — confirmed by reproducing
-- sharePO live and catching the real error ("Bucket not found"), right after fixing the separate
-- `db` vs `storageClient` naming bug in the same function.
--
-- No RLS policies existed on storage.objects at all (default-deny), so even after creating the
-- bucket, the publishable/anon key still couldn't upload — added explicit permissive policies
-- scoped to this one bucket, matching the same staging-only, permissive-by-design posture already
-- used everywhere else in this project (see feedback_api_idempotency_fixed_fields_by_default).
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('order-documents', 'order-documents', true)
on conflict (id) do nothing;

drop policy if exists "order-documents anon insert" on storage.objects;
create policy "order-documents anon insert" on storage.objects for insert to anon with check (bucket_id = 'order-documents');
drop policy if exists "order-documents anon select" on storage.objects;
create policy "order-documents anon select" on storage.objects for select to anon using (bucket_id = 'order-documents');
drop policy if exists "order-documents anon update" on storage.objects;
create policy "order-documents anon update" on storage.objects for update to anon using (bucket_id = 'order-documents');

-- ============================================================================
-- End.
-- ============================================================================
