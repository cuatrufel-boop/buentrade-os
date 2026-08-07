-- BUENTRADE Trading OS — Fase 3.1: seguridad para la tabla customers
-- Permite leer/escribir SOLO a usuarios con sesión válida de Firebase
-- (reconocida por Supabase vía la integración Third-Party Auth ya
-- configurada). Sin esta política, la tabla queda completamente
-- bloqueada para la API pública, aunque RLS ya estaba activado.

create policy "authenticated_full_access_customers"
on customers
for all
to authenticated
using (true)
with check (true);

-- RLS policies only control WHICH rows are visible — the "authenticated"
-- role also needs base table-level grants, which aren't automatic when
-- tables are created directly via the SQL Editor (as opposed to the
-- Supabase dashboard/migrations flow). Without this, requests fail with
-- "permission denied for table customers" even with a correct policy.
grant usage on schema public to authenticated;
grant select, insert, update, delete on customers to authenticated;
