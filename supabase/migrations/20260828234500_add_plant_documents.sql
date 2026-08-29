-- Replaces 5 unused free-text reference fields (avg_response_time, business_hours,
-- avg_loading_time, document_cost, avg_freight_to_border — confirmed via code search that no
-- automated logic ever read them) with real file attachments per plant: the actual pickup
-- authorization letters, health certs, etc. a plant requires, not a text description of them.

create table if not exists plant_documents (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references plants(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  content_type text,
  file_size bigint,
  uploaded_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists plant_documents_plant_id_idx on plant_documents(plant_id);

-- Private bucket — every read/write goes through an Edge Function using the service role, same
-- API-only discipline as the rest of the system. Never exposed directly to the anon/publishable key.
insert into storage.buckets (id, name, public)
values ('plant-documents', 'plant-documents', false)
on conflict (id) do nothing;
