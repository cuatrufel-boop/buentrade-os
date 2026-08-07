create policy "authenticated_full_access_products"
on products
for all
to authenticated
using (true)
with check (true);

grant select, insert, update, delete on products to authenticated;
