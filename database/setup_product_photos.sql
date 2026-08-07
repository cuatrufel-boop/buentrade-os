-- Permite que usuarios autenticados (Firebase, vía el mismo puente que ya
-- usan las demás tablas) suban, actualicen y borren fotos en el bucket
-- "product-photos". La lectura es pública (el bucket ya se creó como
-- público), para que las fotos se puedan compartir por WhatsApp más
-- adelante.

create policy "authenticated_upload_product_photos"
on storage.objects for insert
to authenticated
with check (bucket_id = 'product-photos');

create policy "authenticated_update_product_photos"
on storage.objects for update
to authenticated
using (bucket_id = 'product-photos');

create policy "authenticated_delete_product_photos"
on storage.objects for delete
to authenticated
using (bucket_id = 'product-photos');

create policy "public_read_product_photos"
on storage.objects for select
to public
using (bucket_id = 'product-photos');

-- Columna nueva en products para guardar el link de la foto
alter table products add column photo_url text;
