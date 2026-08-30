-- Real gap confirmed live (2026-08-30): only plants can have a logo uploaded — providers
-- (carriers/customs brokers) and customers have no logo_url column and no bucket at all. Same
-- reasoning as plant-logos: a public bucket, since profiles render logo_url as a plain <img src>
-- with no signed-URL refresh logic.
alter table providers add column if not exists logo_url text;
alter table customers add column if not exists logo_url text;

insert into storage.buckets (id, name, public)
values ('provider-logos', 'provider-logos', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('customer-logos', 'customer-logos', true)
on conflict (id) do nothing;
