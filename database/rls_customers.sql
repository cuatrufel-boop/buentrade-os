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
