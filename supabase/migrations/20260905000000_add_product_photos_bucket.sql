-- plants.html already uploads product photos/spec PDFs to a bucket named 'product-photos'
-- (getPublicUrl, embedded later in the customer offer PDF and emails), but that bucket was
-- never created — every upload has been silently failing. PUBLIC, like plant-logos: the
-- combined-offer-PDF builder and email/WhatsApp sends fetch these files by plain URL with no
-- signed-URL refresh logic, so a private bucket would break exactly like a logo would.
--
-- Size/type capped here (not client-side) to answer the real performance question directly:
-- object storage doesn't get slower as file COUNT grows (it's not a table scan), only per-file
-- SIZE matters for load time. 15MB covers a compressed photo or a scanned spec sheet with room
-- to spare, while stopping an accidental huge raw upload from bloating a customer's PDF/email.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', true, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;
