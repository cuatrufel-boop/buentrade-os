-- Logos need a PUBLIC bucket, unlike plant-documents: the plant list/profile render logo_url
-- directly as a plain <img src>, with no signed-URL refresh logic, so a private bucket would
-- break the image after the signed URL's short TTL expired.
insert into storage.buckets (id, name, public)
values ('plant-logos', 'plant-logos', true)
on conflict (id) do nothing;
