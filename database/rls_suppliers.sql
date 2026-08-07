create policy "authenticated_full_access_suppliers"
on suppliers
for all
to authenticated
using (true)
with check (true);

grant select, insert, update, delete on suppliers to authenticated;
